import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { tr, useArkmeLocale } from './locale.js'
import type { ArkoConversationMessage as ArkoMessage, ArkoConversationHistoryPage } from './arko-conversation-contract.js'
import type { ArkmeArkoAskResult, ArkmeArkoCancelResult, ArkmeArkoHistoryItem, ArkmeArkoHistoryPage, ArkmeArkoModelCatalog, ArkmeArkoProfile, ArkmeArkoRunStatus, ArkmeArkoSession, ArkmeUserProfile, ArkmeUserProfileSnapshot } from '../types.js'
import { callArkme, ArkmeClientError } from './api.js'
import { readArkoPendingTurn, removeArkoPendingTurn, writeArkoPendingTurn, type ArkmeArkoPendingTurn } from './arko-pending-turn-store.js'
import { arkoPresentationName, arkmeArkoProfileStore } from './arko-profile-store.js'
import { arkmeArkoConversationPreviewStore } from './arko-conversation-preview-store.js'
import { arkmeAuthStore } from './auth-store.js'
import { arkmeArkoComposerDraftKey, arkmeComposerDraftStore, serializeArkmeComposerDraft } from './composer-draft-store.js'
export const arkoQuestionMaxLength = 60 * 1024

interface ArkoContinuationTarget {
  assistantMsgId: number
  runUid: string
}

interface ActiveArkoRun extends ArkoContinuationTarget {
  sessionId: number
}

const ACTIVE_RUN_STATUSES = new Set(['accepted', 'queued', 'running', 'stream_timeout', 'waiting_tool'])

function errorMessage(error: unknown): string {
  if (error instanceof ArkmeClientError) return error.body.message
  return error instanceof Error ? error.message : String(error)
}

function isActiveRunStatus(status: string | undefined): boolean {
  return status !== undefined && ACTIVE_RUN_STATUSES.has(status)
}

function isActivityPlaceholderText(value: string): boolean {
  return /^(正在)?(思考|处理)(中)?[.。…]*$/.test(value.trim())
}

function isActiveHistoryRun(item: ArkmeArkoHistoryItem): boolean {
  const placeholder = isActivityPlaceholderText(item.text)
  return item.role === 'assistant' && (isActiveRunStatus(item.runStatus)
    || (item.runStatus === undefined && item.status === 2 && (item.text.trim() === '' || placeholder)))
}

export function arkoHistoryHasTerminalRun(
  items: ArkmeArkoHistoryItem[],
  sessionId: number,
  assistantMsgId: number,
  runUid: string,
): boolean {
  const matchingItem = items.find(item => item.role === 'assistant'
    && item.sessionId === sessionId
    && item.messageId === assistantMsgId
    && (item.runUid === undefined || item.runUid === runUid))
  return matchingItem !== undefined && !isActiveHistoryRun(matchingItem)
}

function waitForNextPoll(signal: AbortSignal, delayMillis = 1_200): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timeout = setTimeout(finish, delayMillis)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function historyMessage(item: ArkmeArkoHistoryItem): ArkoMessage {
  const placeholder = isActivityPlaceholderText(item.text)
  const reasoningPlaceholder = isActivityPlaceholderText(item.reasoning)
  const active = isActiveHistoryRun(item)
  return {
    id: `history:${String(item.messageId)}`,
    messageId: item.messageId,
    sessionId: item.sessionId,
    role: item.role,
    text: active && placeholder ? '' : item.text,
    status: active ? 'sending' : item.runStatus === 'failed' ? 'error' : 'done',
    createdAtMillis: item.createdAtMillis,
    ...(item.reasoning.trim() === '' || (!active && reasoningPlaceholder) ? {} : { reasoning: item.reasoning }),
    ...(item.role !== 'assistant' ? {} : { assistantMsgId: item.messageId }),
    ...(item.runUid === undefined ? {} : { runUid: item.runUid }),
    ...(item.runStatus === undefined ? {} : { runStatus: item.runStatus }),
    ...(item.messageActionRef === undefined ? {} : {
      messageActionRef: item.messageActionRef,
      ...(item.messageActionConversationRef === undefined ? {} : { messageActionConversationRef: item.messageActionConversationRef }),
      copyLinkAvailable: item.messageActionCapabilities?.copyLink === true,
      forwardAvailable: item.messageActionCapabilities?.forward === true,
    }),
  }
}

export function latestActiveRun(
  items: ArkmeArkoHistoryItem[],
  sessionId: number,
): ActiveArkoRun | undefined {
  const item = items
    .filter(candidate => candidate.sessionId === sessionId
      && candidate.role === 'assistant'
      && candidate.runUid !== undefined
      && isActiveRunStatus(candidate.runStatus))
    .sort((left, right) => right.createdAtMillis - left.createdAtMillis || right.messageId - left.messageId)[0]
  if (item?.runUid === undefined) return undefined
  return { sessionId: item.sessionId, assistantMsgId: item.messageId, runUid: item.runUid }
}

export function mergeHistory(current: ArkoMessage[], items: ArkmeArkoHistoryItem[]): ArkoMessage[] {
  const byId = new Map(current.map(item => [item.id, item]))
  for (const item of items) {
    const key = `history:${String(item.messageId)}`
    const prior = byId.get(key)
    byId.set(key, { ...historyMessage(item), ...(prior?.presentationKey ? { presentationKey: prior.presentationKey } : {}) })
  }
  return [...byId.values()].sort((left, right) => {
    const leftAt = left.createdAtMillis ?? Number.MAX_SAFE_INTEGER
    const rightAt = right.createdAtMillis ?? Number.MAX_SAFE_INTEGER
    if (leftAt !== rightAt) return leftAt - rightAt
    const leftId = left.messageId ?? Number.MAX_SAFE_INTEGER
    const rightId = right.messageId ?? Number.MAX_SAFE_INTEGER
    return leftId - rightId
  })
}

function resultText(result: ArkmeArkoAskResult): string {
  if (result.text.trim() !== '') return result.text.trim()
  if (result.errorMessage?.trim()) return result.errorMessage.trim()
  if (isActiveRunStatus(result.run?.status ?? result.status)) return ''
  return '任务已处理。'
}

function latestContinuation(messages: ArkoMessage[], sessionId: number | undefined): ArkoContinuationTarget | undefined {
  if (sessionId === undefined) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'divider') return undefined
    if (message.sessionId !== sessionId) continue
    if (message.role === 'user') return undefined
    if (message.runStatus !== 'waiting_user' || message.runUid === undefined || message.assistantMsgId === undefined) {
      return undefined
    }
    return { runUid: message.runUid, assistantMsgId: message.assistantMsgId }
  }
  return undefined
}

function selectedModelName(catalog: ArkmeArkoModelCatalog | undefined): string {
  return catalog?.options.find(option => option.routeKey === catalog.effectiveRouteKey)?.displayName ?? '模型目录暂不可用'
}

export function useArkoConversationController() {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useArkmeLocale()
  const historyLoadInFlightRef = useRef(false)
  const sendInFlightRef = useRef(false)
  const authSnapshot = useSyncExternalStore(
    arkmeAuthStore.subscribe,
    arkmeAuthStore.getSnapshot,
    arkmeAuthStore.getSnapshot,
  )
  const profileSnapshot = useSyncExternalStore(
    arkmeArkoProfileStore.subscribe,
    arkmeArkoProfileStore.getSnapshot,
    arkmeArkoProfileStore.getSnapshot,
  )
  const profileUserId = authSnapshot.auth?.status === 'authenticated' ? authSnapshot.auth.userId : undefined
  const composerDraftKey = arkmeArkoComposerDraftKey(profileUserId)
  useSyncExternalStore(
    arkmeComposerDraftStore.subscribe,
    arkmeComposerDraftStore.getRevision,
    arkmeComposerDraftStore.getRevision,
  )
  const draftSnapshot = arkmeComposerDraftStore.get(composerDraftKey)
  const draft = draftSnapshot.text
  const accountKey = authSnapshot.auth?.status === 'authenticated' && profileUserId !== undefined
    ? `${authSnapshot.auth.environment}:${String(profileUserId)}` : undefined
  const profile = profileSnapshot.userId === profileUserId ? profileSnapshot.profile : undefined
  const [userProfile, setUserProfile] = useState<ArkmeUserProfile | null>(null)
  const [session, setSession] = useState<ArkmeArkoSession>()
  const [catalog, setCatalog] = useState<ArkmeArkoModelCatalog>()
  const [messages, setMessages] = useState<ArkoMessage[]>([])
  const [historyOffset, setHistoryOffset] = useState<number | null | undefined>(null)
  const [historyError, setHistoryError] = useState('')
  const [historyPageError, setHistoryPageError] = useState('')
  const historyPageAbort = useRef<AbortController>()
  useEffect(() => () => { historyPageAbort.current?.abort() }, [accountKey])
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [clearing, setClearing] = useState(false)
  const clearInFlightRef = useRef(false)
  const [selectingModel, setSelectingModel] = useState(false)
  const modelSelectionInFlightRef = useRef(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [activeRun, setActiveRun] = useState<ActiveArkoRun>()
  const [pendingTurn, setPendingTurn] = useState<ArkmeArkoPendingTurn>()
  useEffect(() => {
    arkmeArkoProfileStore.activateUser(profileUserId)
    arkmeArkoConversationPreviewStore.activateUser(profileUserId)
  }, [profileUserId])

  useEffect(() => {
    if (profileUserId === undefined) return
    arkmeArkoConversationPreviewStore.setLatestFromSurface(profileUserId, messages
      .filter(message => message.role !== 'divider')
      .map(message => ({
        key: message.id,
        text: message.text,
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
        ...(message.createdAtMillis === undefined ? {} : { createdAtMillis: message.createdAtMillis }),
      })))
  }, [messages, profileUserId])

  useEffect(() => {
    if (profileUserId === undefined) {
      setPendingTurn(undefined)
      return
    }
    const restored = readArkoPendingTurn(profileUserId)
    setPendingTurn(restored)
    if (restored === undefined) return
    setMessages(current => {
      if (current.some(item => item.id === restored.localAssistantMessageId)) return current
      return [...current, {
        id: restored.localUserMessageId, presentationKey: restored.localUserMessageId,
        sessionId: restored.sessionId,
        role: 'user',
        text: restored.text,
        status: 'done',
        createdAtMillis: restored.createdAtMillis,
      }, {
        id: restored.localAssistantMessageId, presentationKey: restored.localAssistantMessageId,
        sessionId: restored.sessionId,
        role: 'assistant',
        text: '',
        status: 'error',
        createdAtMillis: restored.createdAtMillis + 1,
      }]
    })
  }, [profileUserId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setHistoryError('')
    void Promise.allSettled([
      callArkme<ArkmeArkoSession>('arko.session', undefined, controller.signal),
      callArkme<ArkmeArkoProfile>('arko.profile', undefined, controller.signal),
      callArkme<ArkmeArkoModelCatalog>('arko.models', undefined, controller.signal),
      callArkme<ArkmeArkoHistoryPage>('arko.history', { limit: 50, offset: 0 }, controller.signal),
      callArkme<ArkmeUserProfileSnapshot>('user.profile', undefined, controller.signal).then(async snapshot => (
        snapshot.profile === null
          ? await callArkme<ArkmeUserProfileSnapshot>('user.profile.refresh', undefined, controller.signal)
          : snapshot
      )),
    ]).then(([sessionResult, profileResult, modelResult, historyResult, userProfileResult]) => {
      if (controller.signal.aborted) return
      if (sessionResult.status === 'rejected') {
        setError(errorMessage(sessionResult.reason))
        return
      }
      setSession(sessionResult.value)
      if (profileResult.status === 'fulfilled' && profileUserId !== undefined) {
        arkmeArkoProfileStore.setProfile(profileUserId, profileResult.value)
      }
      if (modelResult.status === 'fulfilled') setCatalog(modelResult.value)
      if (userProfileResult.status === 'fulfilled') setUserProfile(userProfileResult.value.profile)
      if (historyResult.status === 'fulfilled') {
        setMessages(current => mergeHistory(current, historyResult.value.items))
        setHistoryOffset(historyResult.value.nextOffset)
        const restoredRun = latestActiveRun(historyResult.value.items, sessionResult.value.sessionId)
        if (restoredRun !== undefined) {
          setActiveRun(restoredRun)
          setSending(true)
        }
      } else {
        setHistoryError(tr("加载 Arko 对话记录失败：{v0}", { v0: errorMessage(historyResult.reason) }))
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort() }
  }, [profileUserId])

  useEffect(() => {
    if (activeRun === undefined) return
    const controller = new AbortController()
    let consecutiveFailures = 0
    const finishRun = async (knownHistory?: ArkmeArkoHistoryPage): Promise<void> => {
      const [historyResult, profileResult] = await Promise.allSettled([
        knownHistory === undefined
          ? callArkme<ArkmeArkoHistoryPage>('arko.history', { limit: 50, offset: 0 }, controller.signal)
          : Promise.resolve(knownHistory),
        callArkme<ArkmeArkoProfile>('arko.profile', undefined, controller.signal),
      ])
      if (controller.signal.aborted) return
      if (historyResult.status === 'fulfilled') {
        setMessages(current => mergeHistory(current, historyResult.value.items))
        setHistoryOffset(current => current === null ? historyResult.value.nextOffset : current)
        setHistoryError('')
      } else {
        setHistoryError(tr("刷新 Arko 对话记录失败：{v0}", { v0: errorMessage(historyResult.reason) }))
      }
      if (profileResult.status === 'fulfilled' && profileUserId !== undefined) {
        arkmeArkoProfileStore.setProfile(profileUserId, profileResult.value)
      }
      setActiveRun(current => current?.runUid === activeRun.runUid ? undefined : current)
      setSending(false)
    }
    const poll = async (): Promise<void> => {
      await waitForNextPoll(controller.signal)
      while (!controller.signal.aborted) {
        try {
          const status = await callArkme<ArkmeArkoRunStatus>('arko.run.status', {
            sessionId: activeRun.sessionId,
            runUid: activeRun.runUid,
          }, controller.signal)
          if (controller.signal.aborted) return
          consecutiveFailures = 0
          if (status.status === 'waiting_tool') {
            setNotice('当前任务需要 DSH 尚未支持的客户端操作，可以停止任务后换一种方式重试')
          }
          setMessages(current => current.map(item => item.assistantMsgId === activeRun.assistantMsgId ? {
            ...item,
            runStatus: status.status,
            status: isActiveRunStatus(status.status) ? 'sending' : status.status === 'failed' ? 'error' : 'done',
          } : item))
          if (!isActiveRunStatus(status.status)) {
            await finishRun()
            return
          }
        } catch {
          if (controller.signal.aborted) return
          consecutiveFailures += 1
          try {
            const history = await callArkme<ArkmeArkoHistoryPage>(
              'arko.history',
              { limit: 50, offset: 0 },
              controller.signal,
            )
            if (controller.signal.aborted) return
            if (arkoHistoryHasTerminalRun(
              history.items,
              activeRun.sessionId,
              activeRun.assistantMsgId,
              activeRun.runUid,
            )) {
              await finishRun(history)
              return
            }
          } catch {
            if (controller.signal.aborted) return
          }
        }
        const retryDelay = consecutiveFailures === 0
          ? 1_200
          : Math.min(10_000, 1_200 * (2 ** Math.min(consecutiveFailures - 1, 3)))
        await waitForNextPoll(controller.signal, retryDelay)
      }
    }
    void poll()
    return () => { controller.abort() }
  }, [activeRun, profileUserId])

  const loadEarlier = useCallback(async (): Promise<ArkoConversationHistoryPage> => {
    const offset = historyOffset
    if (typeof offset !== 'number') return { messages: [], hasMore: false }
    if (historyLoadInFlightRef.current) throw new Error('正在加载更早记录')
    const controller = new AbortController()
    historyPageAbort.current = controller
    historyLoadInFlightRef.current = true
    setHistoryPageError('')
    setHistoryLoading(true)
    try {
      const page = await callArkme<ArkmeArkoHistoryPage>('arko.history', { limit: 50, offset }, controller.signal)
      if (controller.signal.aborted) throw new Error('Arko 历史读取已取消')
      if (page.hasMore && (page.nextOffset === undefined || page.nextOffset <= offset)) {
        throw new Error('历史分页未前进，请重试')
      }
      // Older-page content cannot overwrite live content already owned by polling/submission.
      setMessages(current => {
        const ids = new Set(current.map(item => item.messageId))
        const older = page.items.filter(item => {
          if (ids.has(item.messageId)) return false
          ids.add(item.messageId)
          return true
        })
        return [...older.reverse().map(historyMessage), ...current]
      })
      setHistoryOffset(page.nextOffset)
      return { messages: [...page.items].reverse().map(historyMessage), hasMore: page.hasMore }
    } catch (caught) {
      if (!controller.signal.aborted) setHistoryPageError(`加载更早记录失败：${errorMessage(caught)}。请重试。`)
      throw caught
    } finally {
      if (historyPageAbort.current === controller) {
        historyLoadInFlightRef.current = false
        setHistoryLoading(false)
        historyPageAbort.current = undefined
      }
    }
  }, [historyOffset])

  const retryHistory = useCallback(async () => {
    if (historyLoadInFlightRef.current) return
    const controller = new AbortController()
    historyPageAbort.current = controller
    historyLoadInFlightRef.current = true
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const page = await callArkme<ArkmeArkoHistoryPage>('arko.history', { limit: 50, offset: 0 }, controller.signal)
      if (controller.signal.aborted) return
      setMessages(current => mergeHistory(current, page.items))
      setHistoryOffset(current => current === null ? page.nextOffset : current)
      if (session !== undefined) {
        const restoredRun = latestActiveRun(page.items, session.sessionId)
        if (restoredRun !== undefined) {
          setActiveRun(restoredRun)
          setSending(true)
        }
      }
    } catch (caught) {
      if (!controller.signal.aborted) setHistoryError(tr("加载 Arko 对话记录失败：{v0}", { v0: errorMessage(caught) }))
    } finally {
      if (historyPageAbort.current === controller) {
        historyLoadInFlightRef.current = false
        historyPageAbort.current = undefined
        setHistoryLoading(false)
      }
    }
  }, [session])

  const submitTurn = useCallback(async (turn: ArkmeArkoPendingTurn) => {
    if (sendInFlightRef.current || sending || activeRun !== undefined) return false
    sendInFlightRef.current = true
    let handedOffToPolling = false
    setSending(true)
    setError('')
    setNotice('')
    setMessages(current => current.map(item => item.id === turn.localAssistantMessageId
      ? { ...item, text: '', status: 'sending', runStatus: 'accepted' }
      : item))
    try {
      const result = await callArkme<ArkmeArkoAskResult>('arko.ask', {
        text: turn.text,
        sessionId: turn.sessionId,
        clientTurnUid: turn.clientTurnUid,
        waitSeconds: 1,
        ...(turn.modelRouteKey === undefined ? {} : { modelRouteKey: turn.modelRouteKey }),
        ...(turn.replyToRunUid === undefined ? {} : { replyToRunUid: turn.replyToRunUid }),
        ...(turn.replyToAssistantMsgId === undefined ? {} : { replyToAssistantMsgId: turn.replyToAssistantMsgId }),
      })
      if (!alive.current) return false
      removeArkoPendingTurn(turn.userId)
      setPendingTurn(current => current?.clientTurnUid === turn.clientTurnUid ? undefined : current)
      setSession(current => current === undefined ? current : { ...current, sessionId: result.sessionId })
      if (result.profile !== undefined && profileUserId !== undefined) {
        arkmeArkoProfileStore.setProfile(profileUserId, result.profile)
      }
      const runStatus = result.run?.status ?? result.status
      const runActive = isActiveRunStatus(runStatus)
      const hasVisibleReasoning = result.reasoning.trim() !== ''
        && (runActive || !isActivityPlaceholderText(result.reasoning))
      setMessages(current => mergeHistory(current.map(item => item.id === turn.localUserMessageId ? {
        ...item,
        id: `history:${String(result.userMsgId)}`,
        messageId: result.userMsgId,
        sessionId: result.sessionId,
      } : item.id === turn.localAssistantMessageId ? {
        id: `history:${String(result.assistantMsgId)}`,
        presentationKey: item.presentationKey ?? item.id,
        messageId: result.assistantMsgId,
        sessionId: result.sessionId,
        role: 'assistant',
        text: resultText(result),
        status: runActive ? 'sending' : result.errorMessage === undefined ? 'done' : 'error',
        assistantMsgId: result.assistantMsgId,
        ...(item.createdAtMillis === undefined ? {} : { createdAtMillis: item.createdAtMillis }),
        ...(hasVisibleReasoning ? { reasoning: result.reasoning } : {}),
        ...(result.runUid === undefined ? {} : { runUid: result.runUid }),
        runStatus,
      } : item), []))
      if (runActive && result.runUid !== undefined) {
        handedOffToPolling = true
        setActiveRun({
          sessionId: result.sessionId,
          assistantMsgId: result.assistantMsgId,
          runUid: result.runUid,
        })
      }
      return true
    } catch (caught) {
      if (!alive.current) return false
      const message = errorMessage(caught)
      const retryable = !(caught instanceof ArkmeClientError) || caught.body.retryable
      if (retryable) {
        setPendingTurn(turn)
        writeArkoPendingTurn(turn)
        setError(`Arko 发送结果暂未确认：${message}。请重试确认，系统会复用同一次请求，不会重复执行。`)
        setMessages(current => current.map(item => item.id === turn.localAssistantMessageId ? {
          ...item, role: 'assistant', text: '', status: 'error',
        } : item))
      } else {
        removeArkoPendingTurn(turn.userId)
        setPendingTurn(current => current?.clientTurnUid === turn.clientTurnUid ? undefined : current)
        setError(message)
        setMessages(current => current.map(item => item.id === turn.localAssistantMessageId ? {
          ...item, role: 'assistant', text: message, status: 'error',
        } : item))
      }
      return false
    } finally {
      sendInFlightRef.current = false
      if (!handedOffToPolling) setSending(false)
    }
  }, [activeRun, composerDraftKey, profileUserId, sending])

  const interactionLocked = sending || pendingTurn !== undefined || activeRun !== undefined
  const sendDisabled = loading || interactionLocked || clearing || selectingModel
    || session === undefined || profileUserId === undefined
  const inputDisabled = loading || interactionLocked || session === undefined || profileUserId === undefined

  const send = useCallback(async (presetText?: string) => {
    const text = (presetText ?? serializeArkmeComposerDraft(arkmeComposerDraftStore.get(composerDraftKey)).text).trim()
    if (text === '' || sendInFlightRef.current || modelSelectionInFlightRef.current || clearInFlightRef.current || sendDisabled
      || session === undefined || profileUserId === undefined || composerDraftKey === undefined) return false
    if (text.length > arkoQuestionMaxLength) {
      setError('内容长度超过上限，请删减后再发送')
      return false
    }
    const continuation = latestContinuation(messages, session.sessionId)
    const createdAtMillis = Date.now()
    const turn: ArkmeArkoPendingTurn = {
      userId: profileUserId,
      sessionId: session.sessionId,
      clientTurnUid: crypto.randomUUID(),
      text,
      createdAtMillis,
      localUserMessageId: crypto.randomUUID(),
      localAssistantMessageId: crypto.randomUUID(),
      ...(continuation === undefined ? {
        ...(catalog === undefined ? {} : { modelRouteKey: catalog.effectiveRouteKey }),
      } : {
        replyToRunUid: continuation.runUid,
        replyToAssistantMsgId: continuation.assistantMsgId,
      }),
    }
    writeArkoPendingTurn(turn)
    setPendingTurn(turn)
    if (presetText === undefined) arkmeComposerDraftStore.clear(composerDraftKey)
    setMessages(current => [...current, {
      id: turn.localUserMessageId, presentationKey: turn.localUserMessageId,
      sessionId: turn.sessionId,
      role: 'user',
      text,
      status: 'done',
      createdAtMillis,
    }, {
      id: turn.localAssistantMessageId, presentationKey: turn.localAssistantMessageId,
      sessionId: turn.sessionId,
      role: 'assistant',
      text: '',
      status: 'sending',
      runStatus: 'accepted',
      createdAtMillis: createdAtMillis + 1,
    }])
    return await submitTurn(turn)
  }, [catalog, composerDraftKey, messages, profileUserId, sendDisabled, session, submitTurn])

  const selectModel = useCallback(async (routeKey: string) => {
    if (modelSelectionInFlightRef.current || sendInFlightRef.current || clearInFlightRef.current || loading || interactionLocked || clearing
      || catalog === undefined || routeKey === catalog.effectiveRouteKey
      || !catalog.options.some(option => option.routeKey === routeKey)) return false
    modelSelectionInFlightRef.current = true
    setSelectingModel(true)
    setError('')
    try {
      const next = await callArkme<ArkmeArkoModelCatalog>('arko.model.activate', { routeKey })
      if (!alive.current) return false
      setCatalog(next)
      return true
    } catch (caught) {
      setError(errorMessage(caught))
      return false
    } finally {
      modelSelectionInFlightRef.current = false
      setSelectingModel(false)
    }
  }, [catalog, clearing, interactionLocked, loading])

  const cancelActiveRun = useCallback(async () => {
    if (activeRun === undefined || cancelling) return false
    setCancelling(true)
    setError('')
    try {
      await callArkme<ArkmeArkoCancelResult>('arko.cancel', {
        sessionId: activeRun.sessionId,
        assistantMsgId: activeRun.assistantMsgId,
        runUid: activeRun.runUid,
      })
      setNotice('已请求停止当前任务，正在确认最终状态')
      return true
    } catch (caught) {
      setError(tr("停止 Arko 任务失败：{v0}", { v0: errorMessage(caught) }))
      return false
    } finally {
      setCancelling(false)
    }
  }, [activeRun, cancelling])

  const clearContext = useCallback(async () => {
    if (clearInFlightRef.current || sendInFlightRef.current || modelSelectionInFlightRef.current
      || loading || interactionLocked || clearing) return
    clearInFlightRef.current = true
    setClearing(true)
    setError('')
    setNotice('')
    try {
      const nextSession = await callArkme<ArkmeArkoSession>('arko.new-session')
      if (!alive.current) return
      setSession(nextSession)
      setMessages(current => [...current, {
        id: crypto.randomUUID(), role: 'divider', text: '新的对话', status: 'done', createdAtMillis: Date.now(),
      }])
      setNotice('上下文已清除，历史记录仍然保留')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      clearInFlightRef.current = false
      setClearing(false)
    }
  }, [clearing, interactionLocked, loading])

  const displayName = arkoPresentationName(profile)
  const selectedModel = selectedModelName(catalog)
  const canChooseModel = (catalog?.options.length ?? 0) > 1
  const continuation = useMemo(() => latestContinuation(messages, session?.sessionId), [messages, session?.sessionId])
  return {
    accountKey, profileUserId, composerDraftKey, draftSnapshot, draft, userProfile,
    session, catalog, messages, historyOffset, historyError, historyPageError,
    loading, historyLoading, sending, clearing, selectingModel, cancelling,
    error, notice, activeRun, pendingTurn, interactionLocked, sendDisabled, inputDisabled,
    displayName, selectedModel, canChooseModel, continuation,
    send, submitTurn, selectModel, cancelActiveRun, clearContext, loadEarlier, retryHistory,
    setDraft: (text: string) => arkmeComposerDraftStore.setText(composerDraftKey, text),
    feedback: setError,
  }
}

export type ArkoConversationController = ReturnType<typeof useArkoConversationController>
