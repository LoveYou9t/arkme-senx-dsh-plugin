// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ArkoNativeSurface, type ArkoNativeCarrier } from '../src/client/ArkoNativeSurface.js'
import type { ArkoConversationSnapshot } from '../src/client/arko-conversation-contract.js'

it('keeps the native landing page invisible until the session view reports ready and ignores disposed readiness', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<html><head></head><body></body></html>' })))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const snapshot: ArkoConversationSnapshot = { accountKey: 'a', displayName: 'Arko', messages: [], modelCatalog: null, loading: false, busy: false, draft: '', error: '' }
  const actions = { submit: async () => true, selectModel: async () => true, cancel: async () => true, loadEarlier: async () => ({ messages: [], hasMore: false }) }
  const ui = { clearDisabled: false, setDraft: () => {}, clearContext: () => {}, retry: async () => {}, feedback: () => {} }
  try {
    await act(async () => root.render(<ArkoNativeSurface snapshot={snapshot} actions={actions} ui={ui} />))
    const frame = () => host.querySelector('iframe')!
    expect(frame().style.visibility).toBe('hidden')
    expect(frame().getAttribute('aria-hidden')).toBe('true')
    const old = [...window.__arkmeArkoNativeFrames!.values()][0] as ArkoNativeCarrier
    await act(async () => old.ready())
    expect(frame().style.visibility).toBe('visible')
    await act(async () => root.render(<ArkoNativeSurface snapshot={{ ...snapshot, accountKey: 'b' }} actions={actions} ui={ui} />))
    expect(frame().style.visibility).toBe('hidden')
    await act(async () => old.ready())
    expect(frame().style.visibility).toBe('hidden')
    const current = [...window.__arkmeArkoNativeFrames!.values()][0]!
    await act(async () => current.ready())
    expect(frame().style.visibility).toBe('visible')
  } finally {
    await act(async () => root.unmount());host.remove();vi.unstubAllGlobals()
  }
})
