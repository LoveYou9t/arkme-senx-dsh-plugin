import type { ArkoConversationMessage, ArkoConversationSnapshot, ArkoConversationActions } from './arko-conversation-contract.js'

/** Structural form of DSH's public ClientTransportHooks; no runtime DSH import. */
export interface ArkoNativeTransport {
  readonly sessionId: string
  /** The frame owner remounts only for corrections/removals, never for an older page. */
  readonly historyRevision: number
  fetch(input: URL, init: RequestInit): Promise<Response>
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): AsyncIterable<unknown>
  update(snapshot: ArkoConversationSnapshot, actions?: ArkoConversationActions): void
  getSnapshot(): ArkoConversationSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
}

type JsonRecord = Record<string, unknown>
interface WireEvent {
  type: string
  seq: number
  time: number
  data: JsonRecord
  ignorable?: true
  surfaceOp?: 'append'
}
interface EventRecord { type: 'event'; event: WireEvent }
interface ProjectedMessage {
  message: ArkoConversationMessage
  key: string
  seq: number
  turn: number
  ended: boolean
  rpcId?: string
}
interface StreamSink {
  endpoint: string
  historyRevision: number
  push(value: unknown): void
  close(): void
}
interface AssistantPresentation {
  attemptId: string
  startedAfterSeq: number
  turn: number
  step: number
  nextIndex: number
  stream: JsonRecord[]
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}
function requestOf(payload: unknown): JsonRecord {
  return record(record(record(payload).args).request)
}
function messageKey(message: ArkoConversationMessage): string {
  return message.presentationKey ?? (message.messageId === undefined ? message.id : `arko:${String(message.sessionId ?? '')}:${String(message.messageId)}`)
}
function renderContent(message: ArkoConversationMessage): JsonRecord[] {
  return [
    ...(message.reasoning ? [{ type: 'reasoning', text: message.reasoning }] : []),
    { type: 'text', text: message.text },
  ]
}
function endReason(message: ArkoConversationMessage): JsonRecord {
  if (message.status === 'error' || message.runStatus === 'failed') return { kind: 'error', error: { code: 'ARKO_RUN_FAILED', message: message.text || 'Arko 运行失败' } }
  if (message.runStatus === 'cancelled') return { kind: 'aborted', reason: { kind: 'user' } }
  if (message.runStatus === 'waiting_user') return { kind: 'blocked' }
  if (message.runStatus === 'expired' || message.runStatus === 'partial') return { kind: 'interrupted' }
  return { kind: 'completed' }
}
const ok = (value: unknown) => ({ ok: true as const, value })
const denied = (message: string, code = 'gateway/bad-request') => ({ ok: false as const, error: { code, message, details: {} } })

/**
 * Render-only protocol adapter. Snapshots and admitted actions remain owned by
 * ArkmeArkoSurface; this object owns only DSH cursor/identity presentation data.
 * Unsupported calls never reach the host transport or any Arkme API.
 */
export function createArkoNativeTransport(initial: ArkoConversationSnapshot, initialActions: ArkoConversationActions): ArkoNativeTransport {
  let snapshot = initial
  let actions = initialActions
  const accountKey = initial.accountKey
  const sessionId = `arko-native-${crypto.randomUUID()}`
  const createdAt = Date.now()
  let disposed = false
  let historyRevision = 0
  let submitting = false
  let changingModel = false
  let pendingPrompt: { requestId: string; text: string } | undefined
  const listeners = new Set<() => void>()
  const streams = new Set<StreamSink>()
  // Presentation coordinates have space in both directions. This is not a count,
  // a database ID, or a persisted DSH log; only loaded events allocate memory.
  const sequenceOrigin = 2 ** 40
  let nextSeq = sequenceOrigin
  let pageRequest: Promise<void> | undefined
  let journal: EventRecord[] = []
  let projected: ProjectedMessage[] = []
  let turn = 0
  let assistantRevision = 0
  let activeAssistant: AssistantPresentation | undefined

  function emit(endpoint: string, value: unknown) {
    for (const stream of streams) if (stream.endpoint === endpoint
      && (endpoint !== 'session/follow' || stream.historyRevision === historyRevision)) stream.push(value)
  }
  function append(type: string, data: JsonRecord, message: ArkoConversationMessage, surfaceOp?: WireEvent['surfaceOp']): number {
    const event: WireEvent = {
      type, seq: nextSeq++, time: Math.max(0, Math.trunc(message.createdAtMillis ?? createdAt)), data,
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(type.startsWith('arko/') ? { ignorable: true as const } : {}),
    }
    const entry: EventRecord = { type: 'event', event }
    journal.push(entry)
    emit('session/follow', entry)
    return event.seq
  }
  function appendMessage(row: ProjectedMessage) {
    const { message, key, rpcId } = row
    const source = message.role === 'user'
      ? { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) }
      : message.role === 'divider'
        ? { kind: 'plugin', plugin: 'arko', form: 'notice', summary: message.text }
        // Arko history does not expose its originating model; do not attribute
        // old replies to the user's currently selected model.
        : { kind: 'model', provider: 'arko', model: 'unspecified' }
    const wire = { id: key, role: message.role === 'assistant' ? 'assistant' : 'user', source, content: renderContent(message) }
    const type = message.role === 'assistant' ? 'assistant/message' : 'user/message'
    const data = message.role === 'assistant' ? {
      turn: row.turn, step: 1, message: wire, stream: activeAssistant?.attemptId === key ? activeAssistant.stream.slice() : [],
      ...(['cancelled', 'partial', 'expired'].includes(message.runStatus ?? '') ? { interrupted: true } : {}),
    } : wire
    row.seq = append(type, data, message, 'append')
  }
  function assistantFrame(frame: JsonRecord) {
    emit('session/follow', { type: 'assistant-stream', frame: { ...frame, revision: ++assistantRevision } })
  }
  function assistantChunk(chunk: JsonRecord, message: ArkoConversationMessage) {
    if (activeAssistant === undefined) return
    const time = Math.max(0, Math.trunc(message.createdAtMillis ?? createdAt))
    const index = activeAssistant.nextIndex++
    activeAssistant.stream.push({ type: 'chunk', time, chunk })
    assistantFrame({ type: 'chunk', attemptId: activeAssistant.attemptId, index, time, chunk })
  }
  function streamMessage(row: ProjectedMessage, previous?: ArkoConversationMessage) {
    if (activeAssistant?.attemptId !== row.key) {
      activeAssistant = { attemptId: row.key, startedAfterSeq: nextSeq - 1, turn: row.turn, step: 1, nextIndex: 0, stream: [] }
      assistantFrame({ type: 'start', attemptId: row.key, startedAfterSeq: activeAssistant.startedAfterSeq, turn: row.turn, step: 1 })
    }
    for (const [index, kind] of ['reasoning', 'text'].entries()) {
      const text = kind === 'reasoning' ? row.message.reasoning ?? '' : row.message.text
      const before = previous === undefined ? undefined : kind === 'reasoning' ? previous.reasoning ?? '' : previous.text
      if (before === undefined || !text.startsWith(before)) assistantChunk({ type: 'block-start', index, blockType: kind }, row.message)
      const delta = before !== undefined && text.startsWith(before) ? text.slice(before.length) : text
      if (delta !== '') assistantChunk({ type: `${kind}-delta`, index, text: delta }, row.message)
    }
  }
  function settleAssistant(row: ProjectedMessage) {
    appendMessage(row)
    if (activeAssistant?.attemptId === row.key) {
      assistantFrame({ type: 'end', attemptId: row.key, index: activeAssistant.nextIndex, outcome: { kind: 'committed', eventType: 'assistant/message', seq: row.seq } })
      activeAssistant = undefined
    }
  }
  function endMessage(row: ProjectedMessage) {
    if (row.message.role !== 'assistant' || row.message.status === 'sending' || row.ended) return
    append('step/end', { turn: row.turn, step: 1 }, row.message)
    append('turn/end', { turn: row.turn, reason: endReason(row.message) }, row.message)
    row.ended = true
  }
  function addMessage(message: ArkoConversationMessage) {
    if (message.role === 'user' || turn === 0 || (message.role === 'assistant' && projected.at(-1)?.ended === true)) {
      turn++
      append('turn/start', { turn }, message)
      append('step/start', { turn, step: 1 }, message)
    }
    const row: ProjectedMessage = { message, key: messageKey(message), seq: -1, turn, ended: false }
    if (message.role === 'user' && pendingPrompt !== undefined && message.text.trim() === pendingPrompt.text) {
      row.rpcId = pendingPrompt.requestId
      pendingPrompt = undefined
    }
    if (message.role === 'assistant' && message.status === 'sending') streamMessage(row)
    else appendMessage(row)
    endMessage(row)
    projected.push(row)
  }
  function historyRecord(message: ArkoConversationMessage, seq: number): { entry: EventRecord; row: ProjectedMessage } {
    const key = messageKey(message)
    const wire = { id: key, role: message.role === 'assistant' ? 'assistant' : 'user',
      source: message.role === 'assistant' ? { kind: 'model', provider: 'arko', model: 'unspecified' }
        : message.role === 'divider' ? { kind: 'plugin', plugin: 'arko', form: 'notice', summary: message.text } : { kind: 'user' },
      content: renderContent(message) }
    // A history row proves message content, not the original model's execution log.
    // DSH supports window messages without their unloaded turn/step lifecycle.
    const presentationTurn = seq + 1
    return {
      entry: { type: 'event', event: { type: message.role === 'assistant' ? 'assistant/message' : 'user/message',
        seq, time: Math.max(0, Math.trunc(message.createdAtMillis ?? createdAt)), surfaceOp: 'append',
        data: message.role === 'assistant' ? { turn: presentationTurn, step: 1, message: wire, stream: [],
          ...(['cancelled', 'partial', 'expired'].includes(message.runStatus ?? '') ? { interrupted: true } : {}) } : wire } },
      row: { message, key, seq, turn: presentationTurn, ended: true },
    }
  }
  function prependHistory(messages: readonly ArkoConversationMessage[]) {
    const known = new Set(projected.map(row => row.key))
    const persistedKey = (message: ArkoConversationMessage) => message.messageId === undefined ? undefined : `${message.sessionId}:${message.messageId}`
    const persisted = new Set(projected.map(row => persistedKey(row.message)).filter(key => key !== undefined))
    const older = messages.filter(message => {
      const key = messageKey(message), identity = persistedKey(message)
      if (known.has(key) || (identity !== undefined && persisted.has(identity))) return false
      known.add(key)
      if (identity !== undefined) persisted.add(identity)
      return true
    })
    const base = journal[0]?.event.seq ?? nextSeq
    if (older.length > base) throw new Error('Arko 历史窗口边界已变化，请重新打开会话')
    const entries = older.map((message, index) => historyRecord(message, base - older.length + index))
    journal = [...entries.map(value => value.entry), ...journal]
    projected = [...entries.map(value => value.row), ...projected]
  }
  function seedHistory(messages: readonly ArkoConversationMessage[]) {
    for (const message of messages) {
      if (message.status === 'sending' || message.messageId === undefined) { addMessage(message); continue }
      const value = historyRecord(message, nextSeq++)
      journal.push(value.entry); projected.push(value.row)
      turn = Math.max(turn, value.row.turn)
    }
  }
  function selectedModel() {
    const route = snapshot.modelCatalog?.effectiveRouteKey
    return route ? { provider: 'arko', model: route } : null
  }
  function projectionValues() {
    return {
      title: snapshot.displayName,
      modelSelection: { lastUsed: null, next: selectedModel() },
      // Arko is an established conversation even without history; DSH blank means its workspace wizard.
      sessionListMetadata: { blank: false, lastPromptAt: snapshot.messages.filter(message => message.role === 'user').at(-1)?.createdAtMillis ?? null },
    }
  }
  function projections() { return { asOfSeq: nextSeq - 1, values: projectionValues() } }
  function summary() {
    return { sessionId, updatedAt: snapshot.messages.at(-1)?.createdAtMillis ?? createdAt, running: snapshot.busy, blank: false, projections: projections() }
  }
  function checkSession(request: JsonRecord): boolean { return request.sessionId === sessionId }
  function blocked(): string | undefined {
    return snapshot.loading ? 'Arko 正在加载' : snapshot.inputBlockedReason || (snapshot.busy || submitting || changingModel ? 'Arko 正在处理上一项操作' : undefined)
  }
  async function dispatch(method: string, payload: unknown): Promise<ReturnType<typeof ok> | ReturnType<typeof denied>> {
    const request = requestOf(payload)
    switch (method) {
      case 'settings/describe': return ok({ writable: false, hasDocument: false, namespaces: [] })
      case 'credentials/describe': return ok({})
      case 'dynamicCordisRunner/syncInspectManifest': return ok(null)
      case 'dynamicCordisRunner/inventory':
      case 'commands/list':
      case 'llm/listConfigurableProviders': return ok([])
      case 'agentPresets/list': return ok({ presets: [], authorable: false })
      case 'subagents/list': return ok({ entries: [], parentAvailable: false })
      case 'skills/list': return ok({ skills: [] })
      case 'session/list': return ok({ items: [summary()] })
      case 'llm/listProviders': return ok([{ id: 'arko', name: snapshot.displayName }])
      case 'session/modelCatalog': {
        const catalog = snapshot.modelCatalog
        return ok({
          default: { provider: 'arko', model: catalog?.defaultRouteKey || catalog?.effectiveRouteKey || '' },
          routableProviders: catalog?.options.length ? ['arko'] : [],
          groups: catalog === null ? [] : [{ id: 'arko', name: snapshot.displayName, models: catalog.options.map(option => ({ id: option.routeKey, name: option.displayName, description: option.description })) }],
          failures: [],
        })
      }
      case 'session/selectModel': {
        if (!checkSession(request)) return denied('Arko 会话已失效')
        const reason = blocked(); if (reason !== undefined) return denied(reason)
        if (request.provider !== 'arko' || typeof request.model !== 'string' || request.reasoningEffort !== undefined
          || !snapshot.modelCatalog?.options.some(option => option.routeKey === request.model)) return denied('此 Arko 模型不可用')
        if (request.model === snapshot.modelCatalog.effectiveRouteKey) return ok({ selected: selectedModel() })
        changingModel = true
        try {
          const accepted = await actions.selectModel(request.model)
          if (accepted !== true && snapshot.modelCatalog?.effectiveRouteKey !== request.model) return denied(snapshot.error || 'Arko 模型切换未确认')
          return ok({ selected: { provider: 'arko', model: request.model } })
        } finally { changingModel = false }
      }
      case 'session/prompt': {
        if (!checkSession(request)) return denied('Arko 会话已失效')
        const reason = blocked(); if (reason !== undefined) return denied(reason)
        if (request.mode !== 'queue' || typeof request.requestId !== 'string' || request.requestId.length === 0) return denied('Arko 不支持此发送方式')
        if (!Array.isArray(request.content) || request.content.some(part => record(part).type !== 'text' || typeof record(part).text !== 'string')) return denied('Arko 当前仅支持文字输入')
        const text = request.content.map(part => record(part).text as string).join('').trim()
        if (!text || text.length > 60 * 1024) return denied('Arko 输入为空或超过长度上限')
        submitting = true
        pendingPrompt = { requestId: request.requestId, text }
        try {
          if (await actions.submit(text) !== true) {
            pendingPrompt = undefined
            return denied(snapshot.error || 'Arko 未接受此次发送')
          }
          return ok({ accepted: true })
        } catch (error) {
          pendingPrompt = undefined
          throw error
        } finally { submitting = false }
      }
      case 'session/cancel': {
        if (!checkSession(request)) return denied('Arko 会话已失效')
        if (!snapshot.busy) return denied('Arko 当前没有可停止的运行')
        return await actions.cancel() === true ? ok({ accepted: true }) : denied(snapshot.error || 'Arko 停止请求未确认')
      }
      case 'session/page': {
        if (record(request.address).kind !== 'session' || record(request.address).sessionId !== sessionId) return denied('Arko 会话已失效')
        if (request.beforeSeq !== undefined && (!Number.isSafeInteger(request.beforeSeq) || Number(request.beforeSeq) < 0)) return denied('Arko 历史边界无效')
        const before = typeof request.beforeSeq === 'number' ? request.beforeSeq : Infinity
        const through = typeof request.throughSeq === 'number' ? request.throughSeq : nextSeq - 1
        if (snapshot.hasMore && before <= (journal[0]?.event.seq ?? nextSeq)) {
          pageRequest ??= (async () => {
            const page = await actions.loadEarlier()
            if (disposed) throw new Error('Arko 原生呈现已关闭')
            prependHistory(page.messages)
            snapshot = { ...snapshot, hasMore: page.hasMore }
          })().finally(() => { pageRequest = undefined })
          await pageRequest
        }
        const available = journal.filter(entry => entry.event.seq <= through && entry.event.seq < before)
        const limit = typeof request.maxMessages === 'number' && Number.isSafeInteger(request.maxMessages)
          ? Math.min(50, Math.max(1, request.maxMessages)) : 50
        return ok({ records: available.slice(-limit),
          hasMore: available.length > limit || (snapshot.hasMore === true) })
      }
      default: return denied(`Arko 不支持原生操作：${method}`)
    }
  }

  seedHistory(snapshot.messages)
  const transport: ArkoNativeTransport = {
    sessionId,
    get historyRevision() { return historyRevision },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(next, nextActions) {
      if (disposed) throw new Error('Arko 原生呈现已销毁')
      if (next.accountKey !== accountKey) throw new Error('Arko 账号切换必须建立新的原生呈现')
      const previous = snapshot
      const oldValues = projectionValues()
      snapshot = next
      if (nextActions !== undefined) actions = nextActions
      if (projected.length > 0) {
        const head = next.messages.findIndex(message => messageKey(message) === projected[0]!.key)
        if (head > 0) prependHistory(next.messages.slice(0, head))
      }
      const structural = projected.some((row, index) => {
        const message = next.messages[index]
        if (message === undefined || messageKey(message) !== row.key) return true
        // A committed message is immutable on the native journal. Historical
        // corrections and retries re-open a complete snapshot via the frame owner.
        return row.seq >= 0 && (row.message.text !== message.text || row.message.reasoning !== message.reasoning
          || row.message.role !== message.role || row.message.status !== message.status
          || JSON.stringify(endReason(row.message)) !== JSON.stringify(endReason(message)))
      })
      if (structural) {
        historyRevision++
        journal = []; projected = []; turn = 0; activeAssistant = undefined; assistantRevision = 0
        nextSeq = sequenceOrigin
        seedHistory(next.messages)
      } else {
        for (let index = 0; index < next.messages.length; index++) {
          const message = next.messages[index]!
          const row = projected[index]
          if (row === undefined) { addMessage(message); continue }
          const previousMessage = row.message
          row.message = message
          if (message.role === 'assistant' && row.seq < 0) {
            if (message.status === 'sending') streamMessage(row, previousMessage)
            else settleAssistant(row)
          }
          endMessage(row)
        }
      }
      const values = projectionValues()
      const changedKeys = (Object.keys(values) as Array<keyof typeof values>).filter(key => JSON.stringify(values[key]) !== JSON.stringify(oldValues[key]))
      const context: ArkoConversationMessage = { id: '', role: 'divider', text: '', status: 'done', createdAtMillis: Date.now() }
      if (changedKeys.length > 0) append('arko/presentation', Object.fromEntries(changedKeys.map(key => [key, values[key]])), context)
      for (const key of changedKeys) emit('session/control', { type: 'projection', sessionId, key, value: values[key], seq: nextSeq - 1 })
      if (previous.busy !== next.busy) emit('$events', { type: 'emit', event: 'api-session/status', args: [sessionId, next.busy] })
      if (next.error && previous.error !== next.error) emit('$events', { type: 'emit', event: 'api-session/error', args: [sessionId, next.error] })
      if (JSON.stringify(previous.modelCatalog) !== JSON.stringify(next.modelCatalog)) emit('$events', { type: 'emit', event: 'llm/adapters-updated', args: [] })
      for (const listener of listeners) listener()
    },
    async fetch(_input, init) {
      let rpcId = ''
      let result: ReturnType<typeof ok> | ReturnType<typeof denied>
      try {
        if (typeof init.body !== 'string') throw new Error('Arko 原生请求格式无效')
        const envelope = record(JSON.parse(init.body))
        rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
        if (envelope.type !== 'client-request' || typeof envelope.method !== 'string' || rpcId === '') throw new Error('Arko 原生请求格式无效')
        if (disposed || init.signal?.aborted) result = denied('Arko 原生呈现已关闭')
        else {
          result = await dispatch(envelope.method, envelope.payload)
          if (disposed || init.signal?.aborted) result = denied('Arko 原生呈现已关闭')
        }
      } catch (error) { result = denied(error instanceof Error ? error.message : 'Arko 原生请求失败') }
      return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), { headers: { 'content-type': 'application/json' } })
    },
    async *openStream(endpoint, payload, signal) {
      if (disposed || signal.aborted) return
      if (!['$events', 'session/control', 'session/follow', 'workspace/follow'].includes(endpoint)) throw new Error(`Arko 不支持原生流：${endpoint}`)
      if (endpoint === 'session/follow') {
        const address = record(requestOf(payload).address)
        if (address.kind !== 'session' || address.sessionId !== sessionId) throw new Error('Arko 会话已失效')
      }
      const queue: unknown[] = []
      let wake: (() => void) | undefined
      let ended = false
      const sink: StreamSink = {
        endpoint, historyRevision,
        push(value) { if (!ended) { queue.push(value); wake?.() } },
        close() { ended = true; wake?.() },
      }
      streams.add(sink)
      const abort = () => sink.close()
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (endpoint === '$events') yield { type: 'ready', clientId: crypto.randomUUID(), host: { home: '' } }
        if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
        if (endpoint === 'session/control') yield { type: 'baseline', value: { queues: { [sessionId]: [] }, jobs: { [sessionId]: [] }, projections: { [sessionId]: projections() } } }
        if (endpoint === 'session/follow') yield {
          type: 'snapshot', header: { version: 3, id: sessionId, createdAt, isSeeded: false }, cursor: nextSeq - 1,
          records: journal.slice(), hasMore: snapshot.hasMore === true, projections: projections(), assistantStream: {
            revision: assistantRevision,
            ...(activeAssistant === undefined ? {} : { activeAttempt: { ...activeAssistant, stream: activeAssistant.stream.slice() } }),
          },
        }
        while (!ended) {
          if (queue.length > 0) { yield queue.shift(); continue }
          await new Promise<void>(resolve => { wake = resolve })
          wake = undefined
        }
      } finally {
        streams.delete(sink)
        signal.removeEventListener('abort', abort)
        queue.length = 0
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const stream of streams) stream.close()
      streams.clear()
      listeners.clear()
      journal = []; projected = []; pendingPrompt = undefined; activeAssistant = undefined
    },
  }
  return transport
}
