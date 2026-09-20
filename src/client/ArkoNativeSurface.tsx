import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createArkoNativeTransport } from './arko-native-transport.js'
import type { ArkoConversationActions, ArkoConversationSnapshot } from './arko-conversation-contract.js'
import { arkmeTheme } from './arkme-theme.js'
import { ArkmeArkoAvatar } from './ArkmeArkoAvatar.js'
import { arkoNativeFrameDocument } from './arko-native-frame.js'

export interface ArkoNativeUiActions {
  clearDisabled: boolean
  retryLabel?: string
  setDraft(text: string): void
  clearContext(): void
  retry(): Promise<void>
  feedback(message: string): void
}
export type ArkoNativeCarrier = ReturnType<typeof createArkoNativeTransport> & { ui: ArkoNativeUiActions; ready(): void }
declare global {
  interface Window {
    __arkmeArkoNativeFrames?: Map<string, ArkoNativeCarrier>
    __ARKME_NATIVE_ARKO__?: ArkoNativeCarrier
  }
}

/** This component owns only the native document and its disposable presentation carrier. */
export function ArkoNativeSurface({ snapshot, actions, ui }: {
  snapshot: ArkoConversationSnapshot; actions: ArkoConversationActions; ui: ArkoNativeUiActions
}) {
  const latest = useRef({ snapshot, actions, ui })
  latest.current = { snapshot, actions, ui }
  const carrier = useRef<ArkoNativeCarrier>()
  const [html, setHtml] = useState('')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useLayoutEffect(() => {
    const transport = carrier.current
    if (!transport || transport.getSnapshot().accountKey !== snapshot.accountKey) return
    const revision = transport.historyRevision
    transport.ui = ui
    transport.update(snapshot, actions)
    if (transport.historyRevision !== revision) setAttempt(value => value + 1)
  }, [snapshot, actions, ui])
  useEffect(() => {
    if (snapshot.loading) return
    const controller = new AbortController()
    const key = crypto.randomUUID()
    const current = latest.current
    const transport = Object.assign(createArkoNativeTransport(current.snapshot, current.actions), {
      ui: current.ui, ready: () => { if (!controller.signal.aborted) { setError(''); setReady(true) } },
    })
    carrier.current = transport
    const frames = window.__arkmeArkoNativeFrames ??= new Map()
    frames.set(key, transport)
    setError(''); setHtml(''); setReady(false)
    void fetch('/arkme-self/harness-frame?arkme-arko=1', { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error(`原生页面加载失败（${response.status}）`)
        const source = await response.text()
        if (!controller.signal.aborted) setHtml(arkoNativeFrameDocument(source, key, location.origin))
      }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)) })
    const deadline = window.setTimeout(() => {
      if (!controller.signal.aborted) setReady(value => { if (!value) setError('原生页面启动超时，请重试'); return value })
    }, 30_000)
    return () => {
      controller.abort(); clearTimeout(deadline); transport.dispose(); frames.delete(key)
      if (carrier.current === transport) carrier.current = undefined
    }
  }, [snapshot.accountKey, attempt, snapshot.loading])
  return <section data-arkme-owned="arko-native-surface" style={{ height: '100%', minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
    {error && <div role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>重新加载原生页面</button></div>}
    {!ready && !error && <div role="status" aria-label="正在加载 Arko 对话" data-arko-loading-skeleton
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: arkmeTheme.base }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 24px', borderBottom: `1px solid ${arkmeTheme.border}` }}>
        <ArkmeArkoAvatar size={30} /><span style={{ color: arkmeTheme.text }}>{snapshot.displayName}</span>
      </div>
      <div aria-hidden style={{ flex: 1, width: 'min(720px, 86%)', margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {[70, 45, 82].map((width, index) => <div key={index} style={{ width: `${width}%`, height: index === 1 ? 40 : 64,
          alignSelf: index === 1 ? 'flex-end' : 'flex-start', borderRadius: 12, background: arkmeTheme.layer2 }} />)}
      </div>
      <div style={{ width: 'min(720px, 86%)', margin: '0 auto 24px' }}>
        <div aria-hidden style={{ height: 92, border: `1px solid ${arkmeTheme.border}`, borderRadius: 16, background: arkmeTheme.layer2 }} />
        <div style={{ textAlign: 'center', color: arkmeTheme.secondary, fontSize: 12, paddingTop: 10 }}>正在加载对话…</div>
      </div>
    </div>}
    {html && <iframe name="arkme-arko-native" title="Arko 原生 DSH 页面" srcDoc={html} style={{ border: 0, width: '100%', flex: 1, minHeight: 0, visibility: ready && !error ? 'visible' : 'hidden' }} aria-hidden={!ready || !!error} allow="clipboard-read; clipboard-write" />}
  </section>
}
