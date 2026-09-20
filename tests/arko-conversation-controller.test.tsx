// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useArkoConversationController, type ArkoConversationController } from '../src/client/useArkoConversationController.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeArkoProfileStore } from '../src/client/arko-profile-store.js'
import { arkmeArkoComposerDraftKey, arkmeComposerDraftStore } from '../src/client/composer-draft-store.js'
import { callArkme } from '../src/client/api.js'
import type { ArkmeArkoHistoryItem } from '../src/types.js'

vi.mock('../src/client/api.js', async original => ({
  ...await original<typeof import('../src/client/api.js')>(), callArkme: vi.fn(),
}))
const userId = 90919
const draftKey = arkmeArkoComposerDraftKey(userId)
const result = { sessionId: 88, userMsgId: 31, assistantMsgId: 32, text: '回答', reasoning: '', status: 'completed', createdRecordUids: [] }
const current: ArkmeArkoHistoryItem = { messageId: 20, sessionId: 88, role: 'assistant', text: '当前内容', reasoning: '', status: 1, createdAtMillis: 200, createdRecordUids: [] }
const older = { ...current, messageId: 10, text: '更早内容', createdAtMillis: 100 }
let owner: ArkoConversationController
let root: Root
let host: HTMLDivElement
function Harness() { owner = useArkoConversationController(); return null }
async function mount() { await act(async () => root.render(<Harness />)) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sessionStorage.clear()
  arkmeArkoProfileStore.activateUser(undefined)
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId })
  arkmeComposerDraftStore.clear(draftKey)
  vi.mocked(callArkme).mockImplementation(async operation => {
    if (operation === 'arko.session') return { sessionId: 88 } as never
    if (operation === 'arko.profile') return { displayName: 'Arko', version: 1 } as never
    if (operation === 'arko.models') return { options: [], effectiveRouteKey: 'a' } as never
    if (operation === 'user.profile') return { profile: {} } as never
    if (operation === 'arko.history') return { items: [current], hasMore: true, nextOffset: 50 } as never
    if (operation === 'arko.ask') return result as never
    throw new Error(`Unexpected ${operation}`)
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.unstubAllGlobals(); vi.clearAllMocks()
})

it('loads history through the shared owner, preserves live content and deduplicates within the page', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  vi.mocked(callArkme).mockImplementation(async (op, args, signal) => op === 'arko.history' && args?.offset === 50
    ? { items: [{ ...current, text: '旧快照' }, older, older], hasMore: false } as never
    : base(op, args, signal))
  await mount()
  await act(async () => owner.loadEarlier())
  expect(owner.messages.map(item => item.text)).toEqual(['更早内容', '当前内容'])
  expect(owner.historyOffset).toBeUndefined()
  await act(async () => owner.retryHistory())
  expect(owner.historyOffset).toBeUndefined()
  const calls = vi.mocked(callArkme).mock.calls.filter(([op]) => op === 'arko.history')
  expect(calls.map(([, args]) => args?.offset)).toEqual([0, 50, 0])
})

it('preserves the page boundary and draft on failure and retries the same page', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  let fail = true
  vi.mocked(callArkme).mockImplementation(async (op, args, signal) => {
    if (op !== 'arko.history' || args?.offset !== 50) return base(op, args, signal)
    if (fail) { fail = false; throw Error('页读取失败') }
    return { items: [older], hasMore: false } as never
  })
  await mount()
  await act(async () => owner.setDraft('未发送草稿'))
  await act(async () => { await expect(owner.loadEarlier()).rejects.toThrow('页读取失败') })
  expect(owner.historyPageError).toContain('页读取失败')
  expect(owner.historyError).toBe('')
  expect(owner.historyOffset).toBe(50)
  expect(owner.messages.map(item => item.text)).toEqual(['当前内容'])
  await act(async () => owner.loadEarlier())
  expect(owner.historyPageError).toBe('')
  expect(owner.draft).toBe('未发送草稿')
})

it('does not clear a new draft with identical text when the previous send completes', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  let resolve!: (value: unknown) => void
  vi.mocked(callArkme).mockImplementation((op, args, signal) => op === 'arko.ask'
    ? new Promise(done => { resolve = done }) as never : base(op, args, signal))
  await mount()
  await act(async () => owner.setDraft('同样的问题'))
  let send!: Promise<boolean>
  await act(async () => { send = owner.send() })
  expect(owner.draft).toBe('')
  await act(async () => owner.setDraft('同样的问题'))
  await act(async () => { resolve(result); await send })
  expect(owner.draft).toBe('同样的问题')
})

it('keeps the existing draft when a capability shortcut submits independent text', async () => {
  await mount()
  await act(async () => owner.setDraft('稍后发送'))
  await act(async () => owner.send('你能帮我干什么'))
  expect(owner.draft).toBe('稍后发送')
  expect(vi.mocked(callArkme).mock.calls.find(([op]) => op === 'arko.ask')?.[1]).toMatchObject({ text: '你能帮我干什么' })
})

it('cancels an older-page request on unmount and rejects its late result', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  let resolve!: (value: unknown) => void
  let signal: AbortSignal | undefined
  vi.mocked(callArkme).mockImplementation((op, args, abort) => {
    if (op !== 'arko.history' || args?.offset !== 50) return base(op, args, abort)
    signal = abort
    return new Promise(done => { resolve = done }) as never
  })
  await mount()
  let page!: Promise<unknown>
  await act(async () => { page = owner.loadEarlier() })
  await act(async () => root.unmount())
  expect(signal?.aborted).toBe(true)
  await act(async () => { resolve({ items: [older], hasMore: false }); await expect(page).rejects.toThrow('已取消') })
  root = createRoot(host)
})

it('coalesces same-tick history recovery and cancels it on unmount', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  await mount()
  let resolve!: (value: unknown) => void
  let signal: AbortSignal | undefined
  vi.mocked(callArkme).mockImplementation((op, args, abort) => {
    if (op !== 'arko.history') return base(op, args, abort)
    signal = abort
    return new Promise(done => { resolve = done }) as never
  })
  let first!: Promise<void>
  await act(async () => { first = owner.retryHistory(); await owner.retryHistory() })
  expect(vi.mocked(callArkme).mock.calls.filter(([op]) => op === 'arko.history')).toHaveLength(2)
  await act(async () => root.unmount())
  expect(signal?.aborted).toBe(true)
  await act(async () => { resolve({ items: [older], hasMore: false }); await first })
  root = createRoot(host)
})

it('releases elapsed poll listeners and stops polling when the owner unmounts', async () => {
  const base = vi.mocked(callArkme).getMockImplementation()!
  let signal: AbortSignal | undefined
  vi.mocked(callArkme).mockImplementation(async (op, args, abort) => {
    if (op === 'arko.history') return { items: [{ ...current, runUid: 'running-task', runStatus: 'running' }], hasMore: false } as never
    if (op === 'arko.run.status') { signal = abort; return { status: 'running' } as never }
    return base(op, args, abort)
  })
  const added = vi.spyOn(AbortSignal.prototype, 'addEventListener')
  const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
  vi.useFakeTimers()
  try {
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(1200 * 20) })
    expect(signal).toBeDefined()
    const count = (spy: typeof added) => spy.mock.calls.filter((args, index) => args[0] === 'abort' && spy.mock.contexts[index] === signal).length
    expect(count(added) - count(removed)).toBe(1)
    const calls = vi.mocked(callArkme).mock.calls.filter(([op]) => op === 'arko.run.status').length
    expect(calls).toBe(20)
    await act(async () => root.unmount())
    root = createRoot(host)
    expect(signal?.aborted).toBe(true)
    expect(count(added) - count(removed)).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1200 * 3) })
    expect(vi.mocked(callArkme).mock.calls.filter(([op]) => op === 'arko.run.status')).toHaveLength(calls)
  } finally { vi.useRealTimers(); added.mockRestore(); removed.mockRestore() }
})
