export interface ArkoNativeComposerControls {
  disabled: boolean
  captureSelection(): void
  insertText(text: string): boolean
  getCaretGeometry(): DOMRect | undefined
  getEditorGeometry(): DOMRect
}
export interface ArkoNativeComposerPicker {
  update(state: { disabled: boolean }): void
  dispose(): void
}
export interface ArkoNativeComposerOptions {
  /** The Arko-only frame document or container. Never pass the ordinary DSH document. */
  root: Document | HTMLElement
  locked?: () => boolean
  mountEmojiPicker(host: HTMLElement, controls: ArkoNativeComposerControls): ArkoNativeComposerPicker
  onFeedback?: (message: string) => void
}

// Verified against the installed DSH InputBar and locales, not translated selectors.
const attachmentSelector = 'button[aria-label="添加附件"], button[aria-label="Add attachment"]'
const ownedAttributes = { disabled: '', inert: '', tabindex: '-1', 'aria-hidden': 'true' } as const
const fileNotice = 'Arko 当前仅支持文本和表情，文件未添加。'

/**
 * Adapts only Arko's native composer. Editing stays in the browser/Lexical input
 * path: no private Lexical field, Tiptap command, or direct content mutation.
 * Install before native bootstrap when possible. The installed native file-drop
 * owner uses document bubbling; our document capture runs before that owner.
 */
export function installArkoNativeComposerAdapter(options: ArkoNativeComposerOptions): { refresh(): void; dispose(): void } {
  const { root } = options
  const doc = root.nodeType === 9 ? root as Document : root.ownerDocument!
  const win = doc.defaultView
  if (!win) throw new Error('Arko 输入框需要有效的浏览器 Document')
  let disposed = false
  let binding: ReturnType<typeof bind> | undefined
  const note = doc.createElement('div')
  note.setAttribute('role', 'status')
  note.setAttribute('aria-live', 'polite')
  note.style.cssText = 'font:inherit;font-size:12px;line-height:1.5;padding:4px 8px;color:var(--dsw-alias-label-secondary,#68707c);white-space:pre-wrap'
  const inScope = (node: Node) => root === doc || root.contains(node)
  const feedback = (message: string, recoveryText?: string) => {
    if (disposed) return
    note.replaceChildren(doc.createTextNode(message))
    if (recoveryText) {
      const recovery = doc.createElement('textarea')
      recovery.readOnly = true
      recovery.setAttribute('aria-label', '未插入的文本')
      recovery.value = recoveryText
      recovery.style.cssText = 'display:block;width:100%;box-sizing:border-box;min-height:3em;resize:vertical;color:inherit;background:var(--dsw-specific-input-major,#fff)'
      note.append(recovery)
    }
    const parent = binding?.card ?? (root === doc ? doc.body : root as HTMLElement)
    if (parent && note.parentElement !== parent) parent.append(note)
    options.onFeedback?.(message)
  }

  function bind(button: HTMLButtonElement, card: HTMLElement, editor: HTMLElement) {
    const toolbar = button.parentElement!
    const host = doc.createElement('div')
    host.setAttribute('data-arkme-native-composer-overlay', '')
    host.style.cssText = 'position:absolute;z-index:1;display:grid;place-items:center'
    const previousPosition = toolbar.style.position
    const ownsPosition = ['', 'static'].includes(win!.getComputedStyle(toolbar).position)
    if (ownsPosition) toolbar.style.position = 'relative'
    const attributes = new Map(Object.keys(ownedAttributes).map(name => [name, button.getAttribute(name)]))
    let previousVisibility = button.style.visibility
    let alive = true
    let savedRange: Range | undefined
    let picker: ArkoNativeComposerPicker | undefined
    let disabled = true
    const isDisabled = () => !alive || disposed || !button.isConnected || !editor.isConnected || !inScope(editor)
      || options.locked?.() === true || editor.getAttribute('contenteditable') !== 'true'
      || editor.getAttribute('aria-disabled') === 'true'
      || editor.closest('[inert], [aria-disabled="true"]') !== null
      || ['inert', 'adjudicating', 'submitting'].includes(editor.getAttribute('data-phase') ?? '')
    const captureSelection = () => {
      const selection = doc.getSelection()
      if (!selection?.rangeCount) return
      const range = selection.getRangeAt(0)
      if (editor.contains(range.startContainer) && editor.contains(range.endContainer)) savedRange = range.cloneRange()
    }
    const insertText = (text: string) => {
      if (!text || !alive || disposed) return false
      if (isDisabled()) { feedback('当前输入框不可编辑，请稍后重试。'); return false }
      captureSelection()
      try {
        editor.focus({ preventScroll: true })
        const selection = doc.getSelection()
        if (!selection) throw new Error('Selection unavailable')
        const saved = savedRange && editor.contains(savedRange.startContainer) && editor.contains(savedRange.endContainer)
          ? savedRange : undefined
        const range = saved ? saved.cloneRange() : doc.createRange()
        if (!saved) {
          range.selectNodeContents(editor)
          range.collapse(false)
        }
        selection.removeAllRanges()
        selection.addRange(range)
        if (!doc.execCommand('insertText', false, text)) throw new Error('Native insertion rejected')
        captureSelection()
        return true
      } catch {
        feedback('表情或文字插入失败，请重新选择输入位置后重试。')
        return false
      }
    }
    const controls: ArkoNativeComposerControls = {
      get disabled() { return isDisabled() },
      captureSelection,
      insertText,
      getCaretGeometry: () => {
        captureSelection()
        return savedRange && typeof savedRange.getBoundingClientRect === 'function' ? savedRange.getBoundingClientRect() : undefined
      },
      getEditorGeometry: () => editor.getBoundingClientRect(),
    }
    const rememberExternal = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.target !== button || !record.attributeName) continue
        if (attributes.has(record.attributeName)) attributes.set(record.attributeName, button.getAttribute(record.attributeName))
        if (record.attributeName === 'style' && button.style.visibility !== 'hidden') previousVisibility = button.style.visibility
      }
    }
    const attributeObserver = new win!.MutationObserver(records => { rememberExternal(records); update() })
    const observeAttributes = () => {
      attributeObserver.observe(button, { attributes: true, attributeFilter: [...Object.keys(ownedAttributes), 'style'] })
      attributeObserver.observe(editor, { attributes: true, attributeFilter: ['contenteditable', 'inert', 'aria-disabled', 'data-phase'] })
      // Match the ancestry used by isDisabled, including scope/body ancestors.
      // Observe only these elements and lock attributes, never their subtrees.
      for (let ancestor = editor.parentElement; ancestor; ancestor = ancestor.parentElement) {
        attributeObserver.observe(ancestor, { attributes: true, attributeFilter: ['inert', 'aria-disabled'] })
      }
    }
    const layout = () => {
      if (!alive) return
      const rect = button.getBoundingClientRect()
      host.style.left = `${button.offsetLeft}px`
      host.style.top = `${button.offsetTop}px`
      host.style.width = `${rect.width}px`
      host.style.height = `${rect.height}px`
    }
    function update() {
      if (!alive) return
      rememberExternal(attributeObserver.takeRecords())
      // Disconnect only during our writes, so React's later writes (including a
      // same-value disabled=true) remain observable and are restored on release.
      attributeObserver.disconnect()
      for (const [name, value] of Object.entries(ownedAttributes)) if (button.getAttribute(name) !== value) button.setAttribute(name, value)
      if (button.style.visibility !== 'hidden') button.style.visibility = 'hidden'
      observeAttributes()
      const nextDisabled = isDisabled()
      if (nextDisabled !== disabled) { disabled = nextDisabled; picker?.update({ disabled }) }
      layout()
    }
    toolbar.append(host)
    update()
    try { picker = options.mountEmojiPicker(host, controls) } catch { feedback('表情面板暂不可用，请重新打开 Arko。') }
    const resize = typeof win!.ResizeObserver === 'function' ? new win!.ResizeObserver(layout) : undefined
    resize?.observe(toolbar)
    resize?.observe(button)
    resize?.observe(card)
    doc.addEventListener('selectionchange', captureSelection)
    win!.addEventListener('resize', layout)
    return {
      button, card, editor, host, controls, update,
      dispose() {
        if (!alive) return
        alive = false
        rememberExternal(attributeObserver.takeRecords())
        attributeObserver.disconnect()
        resize?.disconnect()
        doc.removeEventListener('selectionchange', captureSelection)
        win!.removeEventListener('resize', layout)
        picker?.dispose()
        host.remove()
        if (note.parentElement === card) note.remove()
        for (const [name, expected] of Object.entries(ownedAttributes)) {
          if (button.getAttribute(name) !== expected) continue
          const previous = attributes.get(name)
          if (previous === null || previous === undefined) button.removeAttribute(name)
          else button.setAttribute(name, previous)
        }
        if (button.style.visibility === 'hidden') button.style.visibility = previousVisibility
        if (ownsPosition && toolbar.style.position === 'relative') toolbar.style.position = previousPosition
      },
    }
  }

  function refresh() {
    if (disposed) return
    const candidates = Array.from(root.querySelectorAll<HTMLButtonElement>(attachmentSelector))
    const button = candidates.find(candidate => {
      const card = candidate.closest<HTMLElement>('[data-composer-card]')
      return card && inScope(card) && card.querySelector('[data-composer-input]')
    })
    const card = button?.closest<HTMLElement>('[data-composer-card]')
    const editor = card?.querySelector<HTMLElement>('[data-composer-input]')
    if (binding && (binding.button !== button || binding.editor !== editor || binding.card !== card
      || binding.host.parentElement !== button?.parentElement)) { binding.dispose(); binding = undefined }
    if (!binding && button && card && editor) binding = bind(button, card, editor)
    else binding?.update()
  }
  const observer = new win.MutationObserver(records => {
    // Ignore mutations made inside our picker/feedback; native mount and remount
    // events are the only reason to discover a composer again.
    if (records.some(record => !binding?.host.contains(record.target) && !note.contains(record.target))) refresh()
  })
  observer.observe(root, { childList: true, subtree: true })

  const blockFiles = (event: Event) => {
    const target = event.target
    if (!(target instanceof win.Node) || !inScope(target)) return
    const transfer = (event as ClipboardEvent).clipboardData ?? (event as DragEvent).dataTransfer
    if (!transfer || !(Array.from(transfer.types ?? []).includes('Files') || transfer.files?.length
      || Array.from(transfer.items ?? []).some(item => item.kind === 'file'))) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.type === 'dragover' || event.type === 'dragenter') { feedback(fileNotice); return }
    const text = transfer.getData('text/plain')
    if (!text) { feedback(fileNotice); return }
    // Drop on the history/background does not move text into a surprise draft.
    if (binding?.editor.contains(target) && binding.controls.insertText(text)) feedback(`${fileNotice}文字已保留。`)
    else feedback(`${fileNotice}文字尚未插入，请复制下方文本后重试。`, text)
  }
  const blockFileInput = (event: Event) => {
    const target = event.target
    if (!(target instanceof win.HTMLInputElement) || target.type !== 'file' || !inScope(target)
      || !target.closest('[data-composer-card]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    feedback(fileNotice)
  }
  for (const name of ['paste', 'drop', 'dragover', 'dragenter']) doc.addEventListener(name, blockFiles, true)
  for (const name of ['click', 'change']) doc.addEventListener(name, blockFileInput, true)
  refresh()
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      observer.disconnect()
      for (const name of ['paste', 'drop', 'dragover', 'dragenter']) doc.removeEventListener(name, blockFiles, true)
      for (const name of ['click', 'change']) doc.removeEventListener(name, blockFileInput, true)
      binding?.dispose()
      binding = undefined
      note.remove()
    },
  }
}
