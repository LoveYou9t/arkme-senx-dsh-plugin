// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArkmeArkoSurface } from '../src/client/ArkmeArkoSurface.js'
import { arkmeAuthStore } from '../src/client/auth-store.js'
import { arkmeArkoProfileStore } from '../src/client/arko-profile-store.js'
import { arkmeArkoComposerDraftKey, arkmeComposerDraftStore } from '../src/client/composer-draft-store.js'
import { readArkoPendingTurn } from '../src/client/arko-pending-turn-store.js'
import type { ArkoNativeUiActions } from '../src/client/ArkoNativeSurface.js'
import type { ArkoConversationActions, ArkoConversationSnapshot } from '../src/client/arko-conversation-contract.js'
const captured = vi.hoisted(() => ({ props: undefined as undefined | { snapshot: ArkoConversationSnapshot; actions: ArkoConversationActions; ui: ArkoNativeUiActions }, call: vi.fn() }))
vi.mock('../src/client/ArkoNativeSurface.js', () => ({ ArkoNativeSurface: (props: typeof captured.props) => { captured.props = props; return <div data-native-frame /> } }))
vi.mock('../src/client/api.js', async original => ({ ...await original<typeof import('../src/client/api.js')>(), callArkme: captured.call }))
let root: Root
let host: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  sessionStorage.clear()
  arkmeArkoProfileStore.activateUser(undefined)
  arkmeAuthStore.setAuth({ status: 'authenticated', environment: 'test', userId: 90909 })
  arkmeComposerDraftStore.clear(arkmeArkoComposerDraftKey(90909))
  captured.call.mockReset().mockImplementation(async (operation, params) => {
    if (operation === 'arko.session') return { sessionId: 88, name: 'Arko', created: false }
    if (operation === 'arko.profile') return { displayName: 'Arko', version: 1 }
    if (operation === 'user.profile') return { profile: {} }
    if (operation === 'arko.history') return { items: [], hasMore: false }
    if (operation === 'arko.models') return { defaultRouteKey: 'a', effectiveRouteKey: 'a', selectionSource: 'personal', options: [
      { routeKey: 'a', displayName: 'A', provider: 'Arko', description: '', recommended: false, selected: true },
      { routeKey: 'b', displayName: 'B', provider: 'Arko', description: '', recommended: false, selected: false },
    ] }
    if (operation === 'arko.ask') return { sessionId: 88, userMsgId: 1, assistantMsgId: 2, text: '原生回复', reasoning: '', status: 'completed', terminal: true, timedOut: false, createdRecordUids: [] }
    if (operation === 'arko.model.activate') throw new Error('激活失败')
    throw new Error(`Unexpected ${operation} ${JSON.stringify(params)}`)
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<ArkmeArkoSurface native />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('renders the native surface and routes submission through the existing Arko owner', async () => {
  expect(host.querySelector('[data-native-frame]')).not.toBeNull()
  expect(host.querySelector('.arkme-dsh-composer')).toBeNull()
  let accepted: boolean | undefined
  await act(async () => { accepted = await captured.props!.actions.submit('真实接线') })
  expect(accepted).toBe(true)
  const calls = captured.call.mock.calls.filter(([operation]) => operation === 'arko.ask')
  expect(calls).toHaveLength(1)
  expect(calls[0]![1]).toMatchObject({ text: '真实接线', sessionId: 88, clientTurnUid: expect.any(String) })
  expect(captured.props!.snapshot.messages.map(message => message.text)).toEqual(['真实接线', '原生回复'])
  expect(captured.props!.snapshot.messages.every(message => message.presentationKey)).toBe(true)
  expect(captured.props!.snapshot.draft).toBe('')
})
it('reports model activation failure instead of acknowledging a false selection', async () => {
  let accepted: boolean | void = true
  await act(async () => { accepted = await captured.props!.actions.selectModel('b') })
  expect(accepted).toBe(false)
  expect(captured.props!.snapshot.modelCatalog?.effectiveRouteKey).toBe('a')
  expect(captured.props!.snapshot.error).toContain('激活失败')
})
it('rejects oversized native text before creating a pending request', async () => {
  let accepted: boolean | undefined
  await act(async () => { accepted = await captured.props!.actions.submit('x'.repeat(60 * 1024 + 1)) })
  expect(accepted).toBe(false)
  expect(captured.call.mock.calls.some(([operation]) => operation === 'arko.ask')).toBe(false)
})

it('exposes recovery after remount and ignores a late failure from the disposed owner', async () => {
  const base = captured.call.getMockImplementation()!
  let rejectOld!: (reason: Error) => void
  let callCount = 0
  captured.call.mockImplementation((operation, params) => {
    if (operation === 'arko.ask' && ++callCount === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
    return base(operation, params)
  })
  let oldSend!: Promise<boolean>
  await act(async () => { oldSend = captured.props!.actions.submit('跨页面确认') })
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(<ArkmeArkoSurface native />))
  expect(captured.props!.ui.retryLabel).toBe('重试确认')
  expect(captured.props!.ui.clearDisabled).toBe(true)
  await act(async () => captured.props!.ui.retry())
  expect(readArkoPendingTurn(90909)).toBeUndefined()
  await act(async () => { rejectOld(new Error('旧请求超时')); await oldSend })
  expect(readArkoPendingTurn(90909)).toBeUndefined()
})

it('retries the same offset without replacing live content or rewinding exhausted history', async () => {
  const base=captured.call.getMockImplementation()!
  const current={messageId:20,sessionId:88,role:'assistant',text:'当前回复',reasoning:'',status:1,createdAtMillis:200,createdRecordUids:[]}
  const older={...current,messageId:10,text:'旧回复',createdAtMillis:100}
  let failed=false
  captured.call.mockImplementation(async(operation,params)=>{
    if(operation!=='arko.history')return base(operation,params)
    if(params.offset===0)return {items:[current],hasMore:true,nextOffset:50}
    if(!failed){failed=true;throw Error('network')}
    return {items:[{...current,text:'不应覆盖'},older],hasMore:false}
  })
  await act(async()=>{root.unmount();root=createRoot(host);root.render(<ArkmeArkoSurface native />)})
  await act(async()=>{await expect(captured.props!.actions.loadEarlier()).rejects.toThrow('network')})
  expect(captured.props!.snapshot.historyError).toContain('network')
  expect(captured.props!.snapshot.error).toBe('')
  await act(async()=>{await captured.props!.actions.loadEarlier()})
  expect(captured.props!.snapshot.messages.map(m=>m.text)).toEqual(['旧回复','当前回复'])
  expect(captured.props!.snapshot.hasMore).toBe(false)
  expect(captured.call.mock.calls.filter(([op,p])=>op==='arko.history'&&p.offset===50)).toHaveLength(2)
  captured.call.mockImplementation(async(operation,params)=>operation==='arko.history'
    ? {items:[current],hasMore:true,nextOffset:50} : base(operation,params))
  await act(async()=>{await captured.props!.ui.retry()})
  expect(captured.props!.snapshot.hasMore).toBe(false)

})

it('aborts an older-page read when its owner is disposed', async () => {
  const base=captured.call.getMockImplementation()!
  let finish!: (page: unknown)=>void
  let signal: AbortSignal | undefined
  captured.call.mockImplementation(async(operation,params,readSignal)=>{
    if(operation!=='arko.history')return base(operation,params)
    if(params.offset===0)return {items:[],hasMore:true,nextOffset:50}
    signal=readSignal
    return await new Promise(resolve=>{finish=resolve})
  })
  await act(async()=>{root.unmount();root=createRoot(host);root.render(<ArkmeArkoSurface native />)})
  let loading!: Promise<unknown>
  await act(async()=>{loading=captured.props!.actions.loadEarlier().catch(e=>e)})
  await act(async()=>{await root.unmount()})
  expect(signal?.aborted).toBe(true)
  finish({items:[],hasMore:false})
  expect(await loading).toBeInstanceOf(Error)
  root=createRoot(host)
})

it('restores offset paging when a run finishes after the initial history read failed', async () => {
  const base = captured.call.getMockImplementation()!
  const message = { messageId: 2, sessionId: 88, role: 'assistant', text: '完成', reasoning: '', status: 1, createdAtMillis: 200, createdRecordUids: [] }
  let first = true
  captured.call.mockImplementation(async (operation, params) => {
    if (operation === 'arko.history') {
      if (first) { first = false; throw new Error('initial offline') }
      return { items: [message], hasMore: true, nextOffset: 50 }
    }
    if (operation === 'arko.ask') return { sessionId: 88, userMsgId: 1, assistantMsgId: 2, text: '', reasoning: '', runUid: 'run', status: 'running', terminal: false, timedOut: false, createdRecordUids: [] }
    if (operation === 'arko.run.status') return { status: 'completed' }
    return base(operation, params)
  })
  await act(async () => { root.unmount();root=createRoot(host);root.render(<ArkmeArkoSurface native />) })
  expect(captured.props!.snapshot.error).toContain('initial offline')
  vi.useFakeTimers()
  try {
    await act(async () => { await captured.props!.actions.submit('历史故障时仍能提问') })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(captured.props!.snapshot.busy).toBe(false)
    expect(captured.props!.snapshot.hasMore).toBe(true)
    expect(captured.props!.snapshot.error).toBe('')
  } finally { vi.useRealTimers() }
})

it('advances past an empty projected page and rejects a non-advancing offset', async () => {
  const base = captured.call.getMockImplementation()!
  const offsets: number[] = []
  captured.call.mockImplementation(async (operation, params) => {
    if (operation !== 'arko.history') return base(operation, params)
    offsets.push(params.offset)
    return { items: [], hasMore: true, nextOffset: params.offset === 0 ? 50 : 100 }
  })
  await act(async () => { root.unmount(); root = createRoot(host); root.render(<ArkmeArkoSurface native />) })
  await act(async () => { expect(await captured.props!.actions.loadEarlier()).toEqual({ messages: [], hasMore: true }) })
  await act(async () => { await expect(captured.props!.actions.loadEarlier()).rejects.toThrow('历史分页未前进') })
  expect(offsets).toEqual([0, 50, 100])
  expect(captured.props!.snapshot.hasMore).toBe(true)
  expect(captured.props!.snapshot.messages).toEqual([])
})

it('serializes context clearing against duplicate confirmation, sending and model activation', async () => {
  const base = captured.call.getMockImplementation()!
  let complete!: (value: unknown) => void
  captured.call.mockImplementation((operation, params) => operation === 'arko.new-session'
    ? new Promise(resolve => { complete = resolve }) : base(operation, params))
  await act(async () => captured.props!.ui.clearContext())
  const confirm = [...host.querySelectorAll('button')].find(button => button.textContent === '确认清除')!
  await act(async () => {
    confirm.click(); confirm.click()
    expect(await captured.props!.actions.submit('不能发到旧会话')).toBe(false)
    expect(await captured.props!.actions.selectModel('b')).toBe(false)
  })
  expect(captured.call.mock.calls.filter(([op]) => op === 'arko.new-session')).toHaveLength(1)
  expect(captured.call.mock.calls.some(([op]) => op === 'arko.ask' || op === 'arko.model.activate')).toBe(false)
  await act(async () => { complete({ sessionId: 99, name: 'Arko', created: true }) })
  expect(captured.props!.snapshot.sessionId).toBe(99)
  expect(captured.props!.ui.clearDisabled).toBe(false)
})

it('retains the old context on clear failure and allows an explicit retry', async () => {
  const base = captured.call.getMockImplementation()!
  let attempts = 0
  captured.call.mockImplementation(async (operation, params) => {
    if (operation !== 'arko.new-session') return base(operation, params)
    if (++attempts === 1) throw new Error('clear failed')
    return { sessionId: 99, name: 'Arko', created: true }
  })
  const confirm = async () => {
    await act(async () => captured.props!.ui.clearContext())
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '确认清除')!.click())
  }
  await confirm()
  expect(captured.props!.snapshot.sessionId).toBe(88)
  expect(captured.props!.snapshot.error).toContain('clear failed')
  expect(captured.props!.ui.clearDisabled).toBe(false)
  await confirm()
  expect(captured.props!.snapshot.sessionId).toBe(99)
  expect(attempts).toBe(2)
})

it('rejects context confirmation while a model activation is already in flight', async () => {
  const base = captured.call.getMockImplementation()!
  let reject!: (error: Error) => void
  captured.call.mockImplementation((operation, params) => operation === 'arko.model.activate'
    ? new Promise((_resolve, fail) => { reject = fail }) : base(operation, params))
  await act(async () => captured.props!.ui.clearContext())
  const confirm = [...host.querySelectorAll('button')].find(button => button.textContent === '确认清除')!
  let activation!: Promise<boolean | void>
  await act(async () => { activation = captured.props!.actions.selectModel('b'); confirm.click() })
  expect(captured.call.mock.calls.some(([op]) => op === 'arko.new-session')).toBe(false)
  await act(async () => { reject(new Error('activation failed')); await activation })
  expect(captured.props!.ui.clearDisabled).toBe(false)
})

it('coalesces rapid unknown-result confirmations through the existing send guard', async () => {
  const base = captured.call.getMockImplementation()!
  let complete!: (result: unknown) => void
  let asks = 0
  captured.call.mockImplementation(async (operation, params) => {
    if (operation !== 'arko.ask') return base(operation, params)
    if (++asks === 1) throw new Error('unknown result')
    return new Promise(resolve => { complete = resolve })
  })
  await act(async () => { await captured.props!.actions.submit('需要对账的请求') })
  const retry = captured.props!.ui.retry
  let first!: Promise<void>
  let second!: Promise<void>
  await act(async () => { first = retry(); second = retry() })
  expect(asks).toBe(2)
  const requests = captured.call.mock.calls.filter(([op]) => op === 'arko.ask')
  expect(requests[1]![1].clientTurnUid).toBe(requests[0]![1].clientTurnUid)
  await act(async () => {
    complete({ sessionId: 88, userMsgId: 1, assistantMsgId: 2, text: '确认完成', reasoning: '', status: 'completed', terminal: true, createdRecordUids: [] })
    await Promise.all([first, second])
  })
  expect(readArkoPendingTurn(90909)).toBeUndefined()
})

it('switches presentation without restarting business requests or discarding draft and history', async () => {
  await act(async () => captured.props!.ui.setDraft('切换界面仍保留'))
  const before = captured.call.mock.calls.length
  const messages = captured.props!.snapshot.messages
  await act(async () => root.render(<ArkmeArkoSurface />))
  expect(captured.call.mock.calls).toHaveLength(before)
  await act(async () => root.render(<ArkmeArkoSurface native />))
  expect(captured.call.mock.calls).toHaveLength(before)
  expect(captured.props!.snapshot.draft).toBe('切换界面仍保留')
  expect(captured.props!.snapshot.messages).toBe(messages)
})
