// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, mountArkoNativeEmojiPicker } from '../src/client/arko-native-emoji-picker.js'
import type { ArkoNativeComposerControls, ArkoNativeComposerPicker } from '../src/client/arko-native-composer.js'

const adapter = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('../src/client/arko-native-composer.js', () => ({ installArkoNativeComposerAdapter: adapter.install }))
vi.mock('../src/client/ArkmeEmojiPicker.js', () => ({
  ArkmeEmojiPicker: (props: {
    mode: string; disabled: boolean; accountKey?: string; scopeKey?: string
    onSelect(emoji: { unicode: string; token: string }): boolean
  }) => <button disabled={props.disabled} data-mode={props.mode} data-account={props.accountKey}
    data-scope={props.scopeKey} onClick={() => props.onSelect({ unicode: '😊', token: '[jm_emoji:smiling_face]' })}>表情</button>,
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks() })

describe('Arko native emoji picker boundary', () => {
  it('registers a mounting capability without modifying an ordinary DSH page', () => {
    const provide = vi.fn()
    apply({ reflect: { provide } } as unknown as Parameters<typeof apply>[0])
    expect(provide).toHaveBeenCalledExactlyOnceWith('arkoNativeComposer', mountArkoNativeEmojiPicker)
    expect(adapter.install).not.toHaveBeenCalled()
    expect(document.body.childElementCount).toBe(0)
  })

  it('keeps picker rendering in the editor document instead of portaling into another account frame', () => {
    expect(() => mountArkoNativeEmojiPicker({
      root: document.implementation.createHTMLDocument(), accountKey: 'test:1', scopeKey: 'arko:1', onFeedback: vi.fn(),
    })).toThrow('所属页面')
    expect(adapter.install).not.toHaveBeenCalled()
  })

  it('uses text-only emoji semantics, propagates locks and releases its React root', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const controls: ArkoNativeComposerControls = {
      disabled: false, captureSelection: vi.fn(), insertText: vi.fn(() => true),
      getCaretGeometry: () => undefined, getEditorGeometry: () => new DOMRect(),
    }
    let picker: ArkoNativeComposerPicker | undefined
    adapter.install.mockImplementation(options => {
      picker = options.mountEmojiPicker(host, controls)
      return { refresh: vi.fn(), dispose: () => picker?.dispose() }
    })
    let mounted: ReturnType<typeof mountArkoNativeEmojiPicker> | undefined
    await act(async () => { mounted = mountArkoNativeEmojiPicker({
      root: document, accountKey: 'test:1', scopeKey: 'arko:1', onFeedback: vi.fn(),
    }) })
    const trigger = host.querySelector('button')!
    expect(trigger.dataset.mode).toBe('text')
    expect(trigger.dataset.account).toBe('test:1')
    expect(trigger.dataset.scope).toBe('arko:1')
    await act(async () => { trigger.click() })
    expect(controls.insertText).toHaveBeenCalledExactlyOnceWith('😊')
    await act(async () => { picker!.update({ disabled: true }) })
    trigger.click()
    expect(controls.insertText).toHaveBeenCalledTimes(1)
    await act(async () => { mounted!.dispose() })
    expect(host.childElementCount).toBe(0)
  })
})
