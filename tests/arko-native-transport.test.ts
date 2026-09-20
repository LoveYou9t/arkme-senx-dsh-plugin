import { afterEach, describe, expect, it, vi } from 'vitest'
import { createArkoNativeTransport } from '../src/client/arko-native-transport.js'
import type { ArkoConversationActions, ArkoConversationSnapshot } from '../src/client/arko-conversation-contract.js'

const historyStart = 2 ** 40

const initial = (): ArkoConversationSnapshot => ({
  accountKey: 'test:account-a', displayName: '我的 Arko', sessionId: 12,
  messages: [
    { id: 'history:1', sessionId: 11, messageId: 1, role: 'user', text: '先前问题', status: 'done', createdAtMillis: 1 },
    { id: 'history:2', sessionId: 11, messageId: 2, role: 'assistant', text: '先前回答', reasoning: '先前思考', status: 'done', createdAtMillis: 2 },
  ],
  modelCatalog: { defaultRouteKey: 'a', effectiveRouteKey: 'a', selectionSource: 'default', options: [
    { routeKey: 'a', displayName: '模型 A', description: '说明 A', provider: 'vendor-a', selected: true, recommended: true },
    { routeKey: 'b', displayName: '模型 B', description: '说明 B', provider: 'vendor-b', selected: false, recommended: false },
  ] }, loading: false, busy: false, draft: '', error: '', hasMore: true,
})
const dispose: Array<() => void> = []
afterEach(() => { dispose.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
function setup(overrides: Partial<ArkoConversationActions> = {}) {
  const actions: ArkoConversationActions = {
    submit: vi.fn(async () => true), selectModel: vi.fn(async () => true), cancel: vi.fn(async () => true),
    loadEarlier: vi.fn(async () => ({ messages: [], hasMore: false })), ...overrides,
  }
  const snapshot = initial()
  const transport = createArkoNativeTransport(snapshot, actions)
  dispose.push(() => transport.dispose())
  async function rpc(method: string, request: unknown = {}) {
    const response = await transport.fetch(new URL('https://example.invalid/api/remote'), {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-test', method, payload: { args: { request } } }),
    })
    const body = await response.json()
    expect(body.type).toBe('server-response'); expect(body.rpcId).toBe('rpc-test')
    return body.result
  }
  function stream(endpoint: string) {
    const controller = new AbortController()
    dispose.push(() => controller.abort())
    return { controller, iterator: transport.openStream(endpoint, { args: { request: { address: { kind: 'session', sessionId: transport.sessionId }, assistantStream: true } } }, controller.signal)[Symbol.asyncIterator]() }
  }
  return { transport, snapshot, actions, rpc, stream }
}

describe('Arko native transport contract', () => {
  it('projects one independent session containing history across business sessions and genuine reasoning', async () => {
    const { transport, rpc, stream } = setup()
    const listed = await rpc('session/list')
    expect(listed.value.items).toHaveLength(1)
    expect(listed.value.items[0].sessionId).toBe(transport.sessionId)
    expect(transport.sessionId).not.toBe('12')
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.type).toBe('snapshot'); expect(frame.header.id).toBe(transport.sessionId)
    expect(frame.hasMore).toBe(true)
    expect(frame.assistantStream).toEqual({ revision: 0 })
    expect(frame.records.map((r: any) => r.event.seq)).toEqual(frame.records.map((_: any, i: number) => historyStart + i))
    const assistant = frame.records.find((r: any) => r.event.type === 'assistant/message').event
    expect(assistant.data.message.content).toEqual([{ type: 'reasoning', text: '先前思考' }, { type: 'text', text: '先前回答' }])
    expect(frame.projections.values).not.toHaveProperty('permissions')
    expect(JSON.stringify(frame)).not.toMatch(/tool\/|approval\/|permission\//)
  })

  it('uses only Arko routes and publishes selection after owner snapshot updates', async () => {
    const { transport, snapshot, rpc, stream, actions } = setup()
    const control = stream('session/control').iterator
    await control.next()
    expect((await rpc('session/modelCatalog')).value.groups).toEqual([{ id: 'arko', name: '我的 Arko', models: [
      { id: 'a', name: '模型 A', description: '说明 A' }, { id: 'b', name: '模型 B', description: '说明 B' },
    ] }])
    expect(await rpc('session/selectModel', { sessionId: transport.sessionId, provider: 'arko', model: 'b' })).toMatchObject({ ok: true, value: { selected: { provider: 'arko', model: 'b' } } })
    expect(actions.selectModel).toHaveBeenCalledWith('b')
    transport.update({ ...snapshot, modelCatalog: { ...snapshot.modelCatalog!, effectiveRouteKey: 'b' } })
    expect((await control.next()).value).toMatchObject({ type: 'projection', key: 'modelSelection', value: { next: { provider: 'arko', model: 'b' } } })
    expect((await rpc('session/selectModel', { sessionId: transport.sessionId, provider: 'host-provider', model: 'b' })).ok).toBe(false)
  })

  it('reconciles native optimistic submission through explicit presentation identity', async () => {
    const { transport, snapshot, actions, rpc, stream } = setup()
    const follow = stream('session/follow').iterator
    await follow.next()
    vi.mocked(actions.submit).mockImplementation(async text => {
      transport.update({ ...snapshot, busy: true, messages: [...snapshot.messages,
        { id: 'temporary-user', presentationKey: 'local-user', role: 'user', text, status: 'done' },
        { id: 'temporary-assistant', presentationKey: 'local-assistant', role: 'assistant', text: '', status: 'sending' },
      ] })
      return true
    })
    expect(await rpc('session/prompt', { sessionId: transport.sessionId, requestId: 'submission-1', mode: 'queue', content: [{ type: 'text', text: '新的问题' }] })).toEqual({ ok: true, value: { accepted: true } })
    const appended: any[] = []
    for (let i = 0; i < 4; i++) appended.push((await follow.next()).value)
    const user = appended.find(r => r.event?.type === 'user/message').event
    expect(user.data.source.rpcId).toBe('submission-1')
    transport.update({ ...transport.getSnapshot(), messages: transport.getSnapshot().messages.map(message => message.presentationKey === 'local-user'
      ? { ...message, id: 'history:3', messageId: 3 } : message.presentationKey === 'local-assistant'
        ? { ...message, id: 'history:4', messageId: 4, text: '持续回答', reasoning: '真实思考' } : message) })
    const chunks: any[] = []
    while (!chunks.some(item => item.frame?.chunk?.type === 'text-delta')) chunks.push((await follow.next()).value)
    expect(chunks.map(item => item.frame?.chunk)).toContainEqual({ type: 'text-delta', index: 1, text: '持续回答' })
    expect(chunks.map(item => item.frame?.chunk)).toContainEqual({ type: 'reasoning-delta', index: 0, text: '真实思考' })
    transport.update({ ...transport.getSnapshot(), busy: false, messages: transport.getSnapshot().messages.map(message => message.presentationKey === 'local-assistant' ? { ...message, status: 'done' } : message) })
    const settled: any = (await follow.next()).value
    expect(settled.event.type).toBe('assistant/message')
    expect(settled.event.surfaceOp).toBe('append')
    expect(settled.event.data.message.id).toBe('local-assistant')
    expect((await follow.next()).value).toMatchObject({ type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: settled.event.seq } } })
    expect(transport.historyRevision).toBe(0)
  })

  it('reports rejection, errors, attachments, steering and unsupported mutations without passthrough', async () => {
    const { transport, rpc, actions } = setup({ submit: vi.fn(async () => false), selectModel: vi.fn(async () => false), cancel: vi.fn(async () => false) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const request = { sessionId: transport.sessionId, requestId: 'denied', mode: 'queue', content: [{ type: 'text', text: '问题' }] }
    expect((await rpc('session/prompt', request)).ok).toBe(false)
    expect((await rpc('session/prompt', { ...request, mode: 'steer' })).ok).toBe(false)
    expect((await rpc('session/prompt', { ...request, content: [{ type: 'image', data: 'bytes' }] })).ok).toBe(false)
    expect(actions.submit).toHaveBeenCalledTimes(1)
    for (const method of ['session/fork', 'session/uploadFile', 'permissions/answer', 'commands/execute', 'unknown/mutation']) expect((await rpc(method)).ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks duplicate submission while admission is in flight, but permits real cancel while busy', async () => {
    let resolve!: (accepted: boolean) => void
    const { transport, snapshot, rpc, actions } = setup({ submit: vi.fn(() => new Promise<boolean>(done => { resolve = done })) })
    const request = { sessionId: transport.sessionId, requestId: 'one', mode: 'queue', content: [{ type: 'text', text: '问题' }] }
    const sending = rpc('session/prompt', request)
    await Promise.resolve()
    expect((await rpc('session/prompt', { ...request, requestId: 'two' })).ok).toBe(false)
    resolve(true); await sending
    transport.update({ ...snapshot, busy: true, inputBlockedReason: '正在运行' })
    expect((await rpc('session/cancel', { sessionId: transport.sessionId })).ok).toBe(true)
    expect(actions.cancel).toHaveBeenCalledTimes(1)
  })

  it('publishes busy and failure facts, and never claims a failed run completed', async () => {
    const { transport, snapshot, stream } = setup()
    const events = stream('$events').iterator; await events.next()
    transport.update({ ...snapshot, busy: true })
    expect((await events.next()).value).toEqual({ type: 'emit', event: 'api-session/status', args: [transport.sessionId, true] })
    transport.update({ ...snapshot, error: '执行失败', messages: [...snapshot.messages, { id: 'failed', role: 'assistant', text: '执行失败', status: 'error', runStatus: 'failed' }] })
    expect((await events.next()).value).toEqual({ type: 'emit', event: 'api-session/status', args: [transport.sessionId, false] })
    expect((await events.next()).value).toEqual({ type: 'emit', event: 'api-session/error', args: [transport.sessionId, '执行失败'] })
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.records.at(-1).event.data.reason).toMatchObject({ kind: 'error' })
  })

  it('preserves cross-session history after context clear and revisions only structural history changes', async () => {
    const { transport, snapshot, rpc, stream, actions } = setup()
    const identity = transport.sessionId
    expect((await rpc('session/create')).ok).toBe(false)
    expect(actions.submit).not.toHaveBeenCalled()
    transport.update({ ...snapshot, sessionId: 15 })
    expect(transport.historyRevision).toBe(0)
    transport.update({ ...snapshot, sessionId: 15, messages: [{ id: 'older', role: 'user', text: '更早', status: 'done' }, ...snapshot.messages] })
    expect(transport.historyRevision).toBe(0)
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.header.id).toBe(identity)
    expect(frame.records.filter((r: any) => r.event.type === 'user/message')).toHaveLength(2)
  })

  it('bootstraps absent host capabilities with honest empty read data', async () => {
    const { rpc, stream } = setup()
    expect(await rpc('commands/list')).toEqual({ ok: true, value: [] })
    expect(await rpc('credentials/describe')).toEqual({ ok: true, value: {} })
    expect(await rpc('settings/describe')).toEqual({ ok: true, value: { writable: false, hasDocument: false, namespaces: [] } })
    expect((await stream('workspace/follow').iterator.next()).value).toEqual({ type: 'baseline', value: { items: [], archivedSessionIds: [] } })
  })

  it('refreshes the native model cache when the owner catalog arrives after boot', async () => {
    const { transport, snapshot, stream } = setup()
    transport.update({ ...snapshot, modelCatalog: null })
    const events = stream('$events').iterator; await events.next()
    transport.update(snapshot)
    expect((await events.next()).value).toEqual({ type: 'emit', event: 'llm/adapters-updated', args: [] })
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.projections.asOfSeq).toBe(frame.cursor)
  })

  it('does not attach a rejected native submission identity to a later independent message', async () => {
    const { transport, snapshot, rpc, stream } = setup({ submit: vi.fn(async () => false) })
    await rpc('session/prompt', { sessionId: transport.sessionId, requestId: 'rejected', mode: 'queue', content: [{ type: 'text', text: '同样的文字' }] })
    transport.update({ ...snapshot, messages: [...snapshot.messages, { id: 'independent', role: 'user', text: '同样的文字', status: 'done' }] })
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.records.findLast((entry: any) => entry.event.type === 'user/message').event.data.source).not.toHaveProperty('rpcId')
  })

  it('gives adjacent standalone replies separate native turn boundaries', async () => {
    const { transport, snapshot, stream } = setup()
    transport.update({ ...snapshot, messages: [
      { id: 'reply-one', role: 'assistant', text: '已完成的回复', status: 'done' },
      { id: 'reply-two', role: 'assistant', text: '仍在生成的回复', status: 'sending' },
    ] })
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.records.filter((entry: any) => entry.event.type === 'turn/start').map((entry: any) => entry.event.data.turn)).toEqual([1, 2])
    expect(frame.assistantStream.activeAttempt.turn).toBe(2)
  })

  it('reconstructs active native chunks and commits cancellation without completing it', async () => {
    const { transport, snapshot, stream } = setup()
    const messages: ArkoConversationSnapshot['messages'] = [...snapshot.messages,
      { id: 'live-user', presentationKey: 'live-user', role: 'user', text: '生成', status: 'done' },
      { id: 'live-answer', presentationKey: 'live-answer', role: 'assistant', text: '一部分', reasoning: '思考中', status: 'sending' },
    ]
    transport.update({ ...snapshot, busy: true, messages })
    const follow = stream('session/follow').iterator
    const opening: any = (await follow.next()).value
    expect(opening.records.some((entry: any) => entry.event.type === 'assistant/message' && entry.event.data.message.id === 'live-answer')).toBe(false)
    expect(opening.assistantStream.activeAttempt.nextIndex).toBe(opening.assistantStream.activeAttempt.stream.length)
    transport.update({ ...snapshot, messages: messages.map(message => message.id === 'live-answer' ? { ...message, status: 'done', runStatus: 'cancelled' } : message) })
    const final: any = (await follow.next()).value
    const end: any = (await follow.next()).value
    expect(final.event.surfaceOp).toBe('append')
    expect(final.event.data.interrupted).toBe(true)
    expect(end.frame.revision).toBe(opening.assistantStream.revision + 1)
    expect(end.frame.index).toBe(opening.assistantStream.activeAttempt.nextIndex)
    await follow.next()
    expect((await follow.next()).value).toMatchObject({ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } } })
  })

  it('rebaselines terminal outcome corrections instead of retaining a stale success', async () => {
    const { transport, snapshot, stream } = setup()
    transport.update({ ...snapshot, messages: snapshot.messages.map(message => message.role === 'assistant' ? { ...message, runStatus: 'cancelled' } : message) })
    expect(transport.historyRevision).toBe(1)
    const frame: any = (await stream('session/follow').iterator.next()).value
    expect(frame.records.find((entry: any) => entry.event.type === 'assistant/message').event.data.interrupted).toBe(true)
  })

  it('isolates accounts, cleans stream listeners on abort/dispose, and rejects stale access', async () => {
    const { transport, snapshot, stream, rpc } = setup()
    const callback = vi.fn(); const unsubscribe = transport.subscribe(callback)
    transport.update({ ...snapshot, draft: '草稿' }); expect(callback).toHaveBeenCalledTimes(1)
    unsubscribe(); transport.update({ ...snapshot, draft: '另一个草稿' }); expect(callback).toHaveBeenCalledTimes(1)
    const active = stream('session/follow'); await active.iterator.next()
    const pending = active.iterator.next(); active.controller.abort()
    expect((await pending).done).toBe(true)
    const other = stream('$events'); await other.iterator.next()
    const waiting = other.iterator.next(); transport.dispose()
    expect((await waiting).done).toBe(true)
    expect((await rpc('session/list')).ok).toBe(false)
    expect(() => transport.update({ ...snapshot, accountKey: 'other-account' })).toThrow()
  })
})

it('prepends owner history without renumbering the current window', async () => {
  const { snapshot, actions } = setup()
  const current = { ...snapshot }
  const native = createArkoNativeTransport(current, actions)
  dispose.push(() => native.dispose())
  const controller = new AbortController(); dispose.push(() => controller.abort())
  const open = () => native.openStream('session/follow', { args: { request: { address: { kind: 'session', sessionId: native.sessionId } } } }, controller.signal)[Symbol.asyncIterator]().next()
  const first: any = (await open()).value
  expect(first.records.map((r: any) => r.event.seq)).toEqual([historyStart, historyStart+1])
  expect(first.hasMore).toBe(true)
  const older = snapshot.messages.map((m,i) => ({...m, id: `old:${i}`, messageId: 100+i, createdAtMillis: i-10}))
  vi.mocked(actions.loadEarlier).mockImplementation(async () => {
    native.update({ ...current, messages: [...older, ...current.messages], hasMore: false })
    return { messages: older, hasMore: false }
  })
  const response = await native.fetch(new URL('https://example.invalid/rpc'), {body:JSON.stringify({type:'client-request',rpcId:'page',method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:native.sessionId},beforeSeq:historyStart,throughSeq:historyStart+1,maxMessages:50}}}})})
  const result = (await response.json()).result
  expect(result.ok).toBe(true)
  expect(result.value.records.map((r:any)=>r.event.seq)).toEqual([historyStart-2,historyStart-1])
  expect(result.value.hasMore).toBe(false)
  expect(native.historyRevision).toBe(0)
  const reopened: any = (await open()).value
  expect(reopened.records.slice(-2)).toEqual(first.records)
  expect(reopened.records).toHaveLength(4)
})

it('coalesces page requests and keeps the window after a failed page', async () => {
  const {snapshot,actions}=setup()
  const native=createArkoNativeTransport({...snapshot},actions);dispose.push(()=>native.dispose())
  let reject!: (error:Error)=>void
  vi.mocked(actions.loadEarlier).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail}))
  const request=()=>native.fetch(new URL('https://example.invalid/rpc'),{body:JSON.stringify({type:'client-request',rpcId:'page',method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:native.sessionId},beforeSeq:historyStart,throughSeq:historyStart+1}}}})}).then(r=>r.json())
  const one=request(),two=request();expect(actions.loadEarlier).toHaveBeenCalledTimes(1)
  reject(new Error('offline'));expect((await one).result.ok).toBe(false);expect((await two).result.ok).toBe(false)
  expect(native.historyRevision).toBe(0);expect(native.getSnapshot().hasMore).toBe(true)
  vi.mocked(actions.loadEarlier).mockResolvedValue({messages:[],hasMore:false})
  expect((await request()).result).toEqual({ok:true,value:{records:[],hasMore:false}})
  expect(actions.loadEarlier).toHaveBeenCalledTimes(2)
})

it('keeps an in-flight assistant attempt intact while older history arrives', async () => {
  const {snapshot,actions}=setup()
  const current={...snapshot}
  const native=createArkoNativeTransport(current,actions);dispose.push(()=>native.dispose())
  const controller=new AbortController();dispose.push(()=>controller.abort())
  const open=()=>native.openStream('session/follow',{args:{request:{address:{kind:'session',sessionId:native.sessionId}}}},controller.signal)[Symbol.asyncIterator]().next()
  const live=[...current.messages,{id:'live-user',role:'user' as const,text:'正在提问',status:'done' as const},{id:'live-assistant',role:'assistant' as const,text:'部分回复',status:'sending' as const}]
  native.update({...current,messages:live,busy:true})
  const before:any=(await open()).value
  const old={id:'older',sessionId:11,messageId:99,role:'user' as const,text:'以前',status:'done' as const}
  vi.mocked(actions.loadEarlier).mockImplementation(async()=>{
    native.update({...current,messages:[old,...live],busy:true,hasMore:false})
    return {messages:[old],hasMore:false}
  })
  const res=await native.fetch(new URL('https://example.invalid/rpc'),{body:JSON.stringify({type:'client-request',rpcId:'page',method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:native.sessionId},beforeSeq:historyStart}}}})})
  expect((await res.json()).result.ok).toBe(true)
  const after:any=(await open()).value
  expect(after.assistantStream).toEqual(before.assistantStream)
  expect(after.records.filter((r:any)=>r.event.seq>=historyStart)).toEqual(before.records)
  expect(native.historyRevision).toBe(0)
})

it('deduplicates persisted history against the stable local presentation identity', async () => {
  const {snapshot,actions}=setup()
  const native=createArkoNativeTransport({...snapshot,messages:snapshot.messages.map(m=>({...m,presentationKey:`local:${m.id}`}))},actions)
  dispose.push(()=>native.dispose())
  vi.mocked(actions.loadEarlier).mockResolvedValue({messages:snapshot.messages,hasMore:false})
  const response=await native.fetch(new URL('https://example.invalid/rpc'),{body:JSON.stringify({type:'client-request',rpcId:'page',method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:native.sessionId},beforeSeq:historyStart}}}})})
  expect((await response.json()).result.value.records).toEqual([])
  expect(native.historyRevision).toBe(0)
})

it('shares the history read but preserves each concurrent caller range', async () => {
  const {snapshot,actions}=setup()
  const native=createArkoNativeTransport({...snapshot},actions);dispose.push(()=>native.dispose())
  let finish!: (page:{messages:typeof snapshot.messages;hasMore:boolean})=>void
  vi.mocked(actions.loadEarlier).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const request=(throughSeq:number)=>native.fetch(new URL('https://example.invalid/rpc'),{body:JSON.stringify({type:'client-request',rpcId:'page',method:'session/page',payload:{args:{request:{address:{kind:'session',sessionId:native.sessionId},beforeSeq:historyStart,throughSeq}}}})}).then(r=>r.json())
  const one=request(historyStart+1),two=request(historyStart-2)
  expect(actions.loadEarlier).toHaveBeenCalledTimes(1)
  finish({messages:snapshot.messages.map((m,i)=>({...m,id:`old:${i}`,messageId:100+i})),hasMore:false})
  expect((await one).result.value.records.map((r:any)=>r.event.seq)).toEqual([historyStart-2,historyStart-1])
  expect((await two).result.value.records.map((r:any)=>r.event.seq)).toEqual([historyStart-2])
})

it('keeps an established Arko conversation usable when history is empty or unavailable', async () => {
  const { transport, snapshot, rpc, stream } = setup()
  transport.update({ ...snapshot, messages: [], hasMore: false })
  const item = (await rpc('session/list')).value.items[0]
  expect(item.blank).toBe(false)
  expect(item.projections.values.sessionListMetadata.blank).toBe(false)
  const frame: any = (await stream('session/follow').iterator.next()).value
  expect(frame.projections.values.sessionListMetadata.blank).toBe(false)
})
