// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installArkoNativeComposerAdapter, type ArkoNativeComposerControls } from '../src/client/arko-native-composer.js'

const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settle = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }
function composer(root: HTMLElement = document.body, label = '添加附件') {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  card.innerHTML = `<div data-composer-input contenteditable="true" role="textbox"><p>原文</p></div><div><button aria-label="${label}">附件</button><input type="file" hidden></div>`
  root.append(card)
  const button = card.querySelector('button')!
  const editor = card.querySelector<HTMLElement>('[data-composer-input]')!
  const toolbar = button.parentElement!
  return { card, button, editor, toolbar }
}
function install(root: Document | HTMLElement = document, locked?: () => boolean) {
  const feedback = vi.fn()
  const mounts: Array<{ host: HTMLElement; controls: ArkoNativeComposerControls; update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []
  const adapter = installArkoNativeComposerAdapter({ root, ...(locked ? { locked } : {}), onFeedback: feedback,
    mountEmojiPicker(host, controls) {
      const trigger = document.createElement('button'); trigger.textContent = '表情'; trigger.disabled = controls.disabled
      trigger.onclick = () => controls.insertText('😀')
      trigger.onmousedown = event => { event.preventDefault(); controls.captureSelection() }
      host.append(trigger)
      const update = vi.fn(({ disabled }: { disabled: boolean }) => { trigger.disabled = disabled })
      const dispose = vi.fn(() => trigger.remove())
      mounts.push({ host, controls, update, dispose })
      return { update, dispose }
    },
  })
  disposers.push(() => adapter.dispose())
  return { adapter, mounts, feedback }
}
function fileEvent(type: string, target: EventTarget, text = '', hasTypes = true) {
  const file = new File(['image'], 'image.png', { type: 'image/png' })
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: {
    types: hasTypes ? ['Files', ...(text ? ['text/plain'] : [])] : [], files: [file], items: [{ kind: 'file' }],
    getData: (format: string) => format === 'text/plain' ? text : '',
  } })
  target.dispatchEvent(event)
  return event
}
function select(editor: HTMLElement, start: number, end = start) {
  const range = document.createRange(); range.setStart(editor.querySelector('p')!.firstChild!, start); range.setEnd(editor.querySelector('p')!.firstChild!, end)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

// A DOM stand-in only: the integration browser gate must verify real Lexical state/submission.
function nativeInsert() {
  const command = vi.fn((_command: string, _ui: boolean, text: string) => {
    const range = document.getSelection()!.getRangeAt(0); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node)
    range.setStartAfter(node); range.collapse(true); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command })
  return command
}

describe('Arko-owned native composer adaptation', () => {
  it('covers only the explicitly scoped composer and disables the original attachment in all focus channels', () => {
    const ordinary = composer()
    const scope = document.createElement('section'); document.body.append(scope)
    const native = composer(scope)
    const { mounts } = install(scope)
    expect(native.button.disabled).toBe(true)
    expect(native.button.hasAttribute('inert')).toBe(true)
    expect(native.button.tabIndex).toBe(-1)
    expect(native.button.getAttribute('aria-hidden')).toBe('true')
    expect(ordinary.button.disabled).toBe(false)
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.host.style.position).toBe('absolute')
    expect(mounts[0]!.host.parentElement).toBe(native.toolbar)
    expect(mounts[0]!.controls.disabled).toBe(false)
  })

  it('supports the exact installed English label and does not claim a lookalike outside a native card', () => {
    document.body.innerHTML = '<button aria-label="Add attachment">ordinary</button>'
    const native = composer(document.body, 'Add attachment')
    const { mounts } = install()
    expect(mounts).toHaveLength(1)
    expect(native.button.disabled).toBe(true)
    expect(document.body.querySelector('button')!.disabled).toBe(false)
  })

  it('mounts later native inputs, releases removed inputs, and binds the replacement without polling', async () => {
    const { mounts } = install()
    const first = composer(); await settle()
    expect(mounts).toHaveLength(1)
    first.card.remove(); const next = composer(); await settle()
    expect(mounts).toHaveLength(2)
    expect(mounts[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(first.button.disabled).toBe(false)
    expect(next.button.disabled).toBe(true)
    expect(mounts[0]!.controls.insertText('旧输入')).toBe(false)
    await settle()
    expect(mounts).toHaveLength(2)
  })

  it('restores only owned attributes and position, preserving later host changes even before observer delivery', () => {
    const native = composer(); native.button.tabIndex = 2; native.button.setAttribute('aria-hidden', 'false')
    const { adapter } = install()
    native.button.setAttribute('disabled', '') // React may write the same disabled value as our lease.
    native.button.setAttribute('aria-hidden', 'host-new-value')
    native.toolbar.style.position = 'sticky'
    adapter.dispose(); adapter.dispose()
    expect(native.button.disabled).toBe(true)
    expect(native.button.getAttribute('aria-hidden')).toBe('host-new-value')
    expect(native.button.tabIndex).toBe(2)
    expect(native.button.hasAttribute('inert')).toBe(false)
    expect(native.toolbar.style.position).toBe('sticky')
    expect(native.toolbar.querySelector('[data-arkme-native-composer-overlay]')).toBeNull()
  })

  it('keeps the overlay on native geometry while concealing and restoring only the original icon', () => {
    const native = composer()
    native.button.style.color = 'red'
    let left = 31
    Object.defineProperty(native.button, 'offsetLeft', { get: () => left })
    Object.defineProperty(native.button, 'offsetTop', { get: () => 9 })
    native.button.getBoundingClientRect = () => new DOMRect(100, 200, 28, 28)
    const { mounts, adapter } = install()
    expect(mounts[0]!.host.style.left).toBe('31px')
    expect(mounts[0]!.host.style.top).toBe('9px')
    expect(mounts[0]!.host.style.width).toBe('28px')
    expect(mounts[0]!.host.style.height).toBe('28px')
    expect(native.button.style.visibility).toBe('hidden')
    left = 55; window.dispatchEvent(new Event('resize'))
    expect(mounts[0]!.host.style.left).toBe('55px')
    adapter.dispose()
    expect(native.button.style.visibility).toBe('')
    expect(native.button.style.color).toBe('red')
  })

  it('rebinds if native moves the same editor and attachment into a new toolbar/card', async () => {
    const native = composer(); const { mounts } = install()
    const replacement = composer()
    replacement.editor.replaceWith(native.editor)
    replacement.button.replaceWith(native.button)
    native.card.remove()
    await settle()
    expect(mounts).toHaveLength(2)
    expect(mounts[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(mounts[1]!.host.parentElement).toBe(replacement.toolbar)
  })

  it('restores native attributes when no other owner changed them', () => {
    const native = composer(); const { adapter } = install(); adapter.dispose()
    expect(native.button.disabled).toBe(false)
    expect(native.button.hasAttribute('tabindex')).toBe(false)
    expect(native.button.hasAttribute('aria-hidden')).toBe(false)
    expect(native.toolbar.style.position).toBe('')
  })

  it('tracks React property updates and actual editor lock without observer loops', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const reactHost = document.createElement('section'); document.body.append(reactHost)
    const reactRoot = createRoot(reactHost); disposers.push(() => act(() => reactRoot.unmount()))
    const render = (disabled: boolean) => act(() => reactRoot.render(<div data-composer-card><div data-composer-input suppressContentEditableWarning contentEditable={!disabled} aria-disabled={disabled}>文本</div><div><button disabled={disabled} aria-label="添加附件">附件</button></div></div>))
    render(false)
    const { mounts, adapter } = install(reactHost)
    render(true); await settle()
    expect(mounts[0]!.update).toHaveBeenLastCalledWith({ disabled: true })
    expect(mounts[0]!.controls.insertText('😀')).toBe(false)
    render(false); await settle()
    expect(reactHost.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.disabled).toBe(true)
    expect(mounts[0]!.update).toHaveBeenLastCalledWith({ disabled: false })
    const updates = mounts[0]!.update.mock.calls.length
    await settle(); expect(mounts[0]!.update).toHaveBeenCalledTimes(updates)
    adapter.dispose()
    expect(reactHost.querySelector<HTMLButtonElement>('[aria-label="添加附件"]')!.disabled).toBe(false)
  })

  it.each([
    ['editor', 'inert'],
    ['nested', 'inert'],
    ['nested', 'aria-disabled'],
    ['outside-card', 'aria-disabled'],
    ['scope', 'inert'],
    ['outside-scope', 'aria-disabled'],
  ])('synchronizes picker lock and unlock for %s %s without relying on other DOM mutations', async (place, attribute) => {
    const outside = document.createElement('main'); document.body.append(outside)
    const scope = document.createElement('section'); outside.append(scope)
    const cardParent = document.createElement('article'); scope.append(cardParent)
    const native = composer(cardParent)
    const nested = document.createElement('div'); native.editor.replaceWith(nested); nested.append(native.editor)
    const target = ({ editor: native.editor, nested, 'outside-card': cardParent, scope, 'outside-scope': outside })[place]!
    const { mounts, adapter } = install(scope)
    await settle() // Drain initial mounting records: only the lock attribute can notify the picker now.
    const picker = mounts[0]!
    const trigger = picker.host.querySelector<HTMLButtonElement>('button')!
    target.setAttribute(attribute!, attribute === 'inert' ? '' : 'true')
    expect(picker.controls.disabled).toBe(true)
    await settle()
    expect(picker.update).toHaveBeenLastCalledWith({ disabled: true })
    expect(trigger.disabled).toBe(true)
    target.removeAttribute(attribute!)
    await settle()
    expect(picker.update).toHaveBeenLastCalledWith({ disabled: false })
    expect(trigger.disabled).toBe(false)
    expect(picker.controls.disabled).toBe(false)
    const changes = picker.update.mock.calls.length
    adapter.dispose()
    target.setAttribute(attribute!, attribute === 'inert' ? '' : 'true')
    await settle()
    expect(picker.update).toHaveBeenCalledTimes(changes)
  })

  it('moves ancestor subscriptions with the resident editor and ignores unrelated descendants', async () => {
    const native = composer()
    const oldAncestor = document.createElement('div'); native.editor.replaceWith(oldAncestor); oldAncestor.append(native.editor)
    const { mounts } = install()
    await settle()
    const picker = mounts[0]!
    const newAncestor = document.createElement('div'); native.card.prepend(newAncestor); newAncestor.append(native.editor)
    await settle()
    newAncestor.setAttribute('aria-disabled', 'true')
    await settle()
    expect(picker.update).toHaveBeenLastCalledWith({ disabled: true })
    newAncestor.removeAttribute('aria-disabled')
    await settle()
    expect(picker.update).toHaveBeenLastCalledWith({ disabled: false })
    const changes = picker.update.mock.calls.length
    oldAncestor.setAttribute('inert', '')
    oldAncestor.setAttribute('aria-disabled', 'true')
    await settle()
    expect(picker.update).toHaveBeenCalledTimes(changes)
    expect(picker.controls.disabled).toBe(false)
  })

  it('restores a saved selection for Unicode insertion and rejects a newly locked business state immediately', () => {
    const native = composer(); let locked = false; const { mounts, adapter } = install(document, () => locked)
    const command = nativeInsert(); select(native.editor, 1, 2); mounts[0]!.controls.captureSelection()
    document.getSelection()!.removeAllRanges()
    expect(mounts[0]!.controls.insertText('😀')).toBe(true)
    expect(native.editor.textContent).toBe('原😀')
    expect(command).toHaveBeenCalledWith('insertText', false, '😀')
    locked = true
    expect(mounts[0]!.controls.insertText('越界')).toBe(false)
    adapter.refresh(); expect(mounts[0]!.update).toHaveBeenLastCalledWith({ disabled: true })
  })

  it.each(['paste', 'drop', 'dragover'])('blocks %s with files at the dedicated document before native document listeners', async type => {
    const native = composer(); const upstream = vi.fn(); document.addEventListener(type, upstream)
    disposers.push(() => document.removeEventListener(type, upstream))
    const { feedback } = install()
    expect(fileEvent(type, type === 'paste' ? native.editor : document.body).defaultPrevented).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
    expect(feedback).toHaveBeenCalledWith(expect.stringContaining('仅支持文本和表情'))
    expect(document.querySelector('[role="status"]')?.textContent).toContain('仅支持文本和表情')
  })

  it('also detects files from files/items and blocks the hidden file input', () => {
    const native = composer(); install()
    expect(fileEvent('paste', native.editor, '', false).defaultPrevented).toBe(true)
    const change = new Event('change', { bubbles: true, cancelable: true }); const observed = vi.fn()
    native.card.addEventListener('change', observed); native.card.querySelector('input')!.dispatchEvent(change)
    expect(observed).not.toHaveBeenCalled()
    expect(change.defaultPrevented).toBe(true)
  })

  it('leaves pure text and non-Arko subtree paste/drop untouched', () => {
    const outside = composer(); const scope = document.createElement('section'); document.body.append(scope); const native = composer(scope); install(scope)
    const text = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(text, 'clipboardData', { value: { types: ['text/plain'], files: [], items: [{ kind: 'string' }] } })
    native.editor.dispatchEvent(text); expect(text.defaultPrevented).toBe(false)
    expect(fileEvent('paste', outside.editor).defaultPrevented).toBe(false)
  })

  it('keeps the text portion of a mixed file paste while stopping file intake', () => {
    const native = composer(); const { feedback } = install(); const command = nativeInsert(); select(native.editor, 2)
    expect(fileEvent('paste', native.editor, '保留文字').defaultPrevented).toBe(true)
    expect(command).toHaveBeenCalledTimes(1)
    expect(native.editor.textContent).toBe('原文保留文字')
    expect(feedback).toHaveBeenCalledWith(expect.stringContaining('文字已保留'))
  })

  it('keeps uninserted mixed text visibly recoverable if native insertion fails or is readonly', () => {
    const native = composer(); const { feedback } = install(); Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    fileEvent('paste', native.editor, '不能丢的文本')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="未插入的文本"]')?.value).toBe('不能丢的文本')
    expect(feedback).toHaveBeenLastCalledWith(expect.stringContaining('复制'))
    native.editor.setAttribute('contenteditable', 'false'); fileEvent('paste', native.editor, '只读时的文字')
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="未插入的文本"]')?.value).toBe('只读时的文字')
    expect(native.editor.textContent).toBe('原文')
  })

  it('recovers mixed text dropped outside the editor without moving it into an unrelated draft', () => {
    const native = composer(); install(); const command = nativeInsert(); select(native.editor, 2)
    fileEvent('drop', document.body, '背景拖入的文字')
    expect(command).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="未插入的文本"]')?.value).toBe('背景拖入的文字')
    expect(native.editor.textContent).toBe('原文')
  })

  it('rejects native aria-disabled and busy phases even if contenteditable has not updated yet', () => {
    const native = composer(); const { mounts } = install(); const command = nativeInsert()
    native.editor.setAttribute('aria-disabled', 'true')
    expect(mounts[0]!.controls.insertText('越界')).toBe(false)
    native.editor.removeAttribute('aria-disabled'); native.editor.setAttribute('data-phase', 'submitting')
    expect(mounts[0]!.controls.insertText('越界')).toBe(false)
    expect(command).not.toHaveBeenCalled()
  })

  it('rejects picker insertion failures visibly and removes every listener and mounted UI on dispose', () => {
    const native = composer(); const { adapter, mounts, feedback } = install()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => { throw new Error('unsupported') } })
    expect(mounts[0]!.controls.insertText('😀')).toBe(false)
    expect(feedback).toHaveBeenCalledWith(expect.stringContaining('插入失败'))
    adapter.dispose()
    expect(fileEvent('paste', native.editor).defaultPrevented).toBe(false)
    expect(mounts[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="status"]')).toBeNull()
  })
})
