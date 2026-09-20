import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ArkoNativeCarrier } from './ArkoNativeSurface.js'
import { mountArkoNativeEmojiPicker } from './arko-native-emoji-picker.js'

export const inject = ['sessions', 'conversation', 'slots']
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.session.header.utilities': { kind: 'list'; scope: 'session'; owner: Record<never, never> }
    'conversation.composer.dock': { kind: 'list'; scope: 'session'; owner: Record<never, never> }
  }
}
interface NativeSessions {
  list: { getSnapshot(): { byId: Record<string, unknown> }; subscribe(listener: () => void): () => void }
  open(id: string): void
}
interface InputProps {
  sessionId: string
  useInput<T>(selector: (state: { draft: string }) => T): T
  inputActions: { setDraft(text: string): void }
}
function ArkoDock({ sessionId, useInput, inputActions }: InputProps) {
  const carrier = window.__ARKME_NATIVE_ARKO__!
  const snapshot = useSyncExternalStore(carrier.subscribe, carrier.getSnapshot, carrier.getSnapshot)
  useEffect(() => {
    if (sessionId === carrier.sessionId && !snapshot.loading) carrier.ready()
  }, [carrier, sessionId, snapshot.loading])
  const draft = useInput(state => state.draft)
  const seeded = useRef(false)
  const lastNative = useRef(draft)
  const lastOwner = useRef(snapshot.draft)
  useEffect(() => {
    if (!seeded.current) {
      seeded.current = true
      inputActions.setDraft(snapshot.draft)
    } else if (snapshot.draft !== lastOwner.current && draft === lastNative.current) {
      inputActions.setDraft(snapshot.draft)
    } else if (draft !== lastNative.current) {
      carrier.ui.setDraft(draft)
    }
    lastNative.current = draft
    lastOwner.current = snapshot.draft
  }, [draft, snapshot.draft, inputActions, carrier])
  if (!snapshot.error && !snapshot.historyError && !snapshot.notice && !carrier.ui.retryLabel) return null
  return <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '4px 12px' }}>
    {snapshot.error && <div role="alert">{snapshot.error}</div>}
    {snapshot.historyError && <div role="alert">{snapshot.historyError}</div>}
    {snapshot.notice && <div role="status">{snapshot.notice}</div>}
    <div style={{ display: 'flex', gap: 12 }}>
      {carrier.ui.retryLabel && <Button variant="ghost" size="sm" disabled={snapshot.busy || snapshot.loading} onClick={() => { void carrier.ui.retry() }}>{carrier.ui.retryLabel}</Button>}
    </div>
  </div>
}

function ArkoHeaderActions() {
  const carrier = window.__ARKME_NATIVE_ARKO__!
  useSyncExternalStore(carrier.subscribe, carrier.getSnapshot, carrier.getSnapshot)
  return <Button variant="ghost" size="sm" disabled={carrier.ui.clearDisabled} onClick={() => carrier.ui.clearContext()}>清除上下文</Button>
}

function SkipArkoWelcomeNotice({ complete }: { complete(): void }) {
  useEffect(() => { complete() }, [complete])
  return null
}

/** All conversation rendering remains owned by the native DSH plugins. */
export function apply(ctx: ClientContext): void {
  const carrier: ArkoNativeCarrier | undefined = window.__ARKME_NATIVE_ARKO__
  if (!carrier) throw new Error('Arko native carrier missing')
  ctx.effect(() => {
    let stopped = false
    let opened = false
    const sessions = ctx.sessions as unknown as NativeSessions
    const open = () => {
      if (stopped || opened || !sessions.list.getSnapshot().byId[carrier.sessionId]) return
      opened = true
      sessions.open(carrier.sessionId)
    }
    const off = sessions.list.subscribe(open)
    open()
    const emoji = mountArkoNativeEmojiPicker({ root: document,
      accountKey: carrier.getSnapshot().accountKey, scopeKey: carrier.sessionId,
      locked: () => carrier.getSnapshot().busy || carrier.getSnapshot().loading,
      onFeedback: message => carrier.ui.feedback(message),
    })
    const conversation = (ctx as unknown as { conversation: { blocks: { set(id: string, block: { reason: string } | undefined): void } } }).conversation
    const sync = () => {
      const snapshot = carrier.getSnapshot()
      conversation.blocks.set(carrier.sessionId, snapshot.inputBlockedReason ? { reason: snapshot.inputBlockedReason } : undefined)
      emoji.refresh()
    }
    const unwatch = carrier.subscribe(sync)
    sync()
    return () => { stopped = true; off(); unwatch(); emoji.dispose(); conversation.blocks.set(carrier.sessionId, undefined) }
  })
  // Shadow only this presentation step in the Arko frame; never acknowledge
  // the product-wide notice or modify the ordinary DSH settings document.
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'welcome-notice', priority: -100, order: -100,
  }, SkipArkoWelcomeNotice))
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'arkme-arko-clear-context', order: 10,
  }, ArkoHeaderActions))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'arkme-arko-business-actions', order: 10,
  }, ArkoDock as never))
}
