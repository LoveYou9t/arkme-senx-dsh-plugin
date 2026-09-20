import { createRoot } from 'react-dom/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { ArkmeEmojiPicker } from './ArkmeEmojiPicker.js'
import {
  installArkoNativeComposerAdapter,
  type ArkoNativeComposerControls,
  type ArkoNativeComposerPicker,
} from './arko-native-composer.js'

/** Mount inside the Arko document's own React realm, never in the parent DSH page. */
export interface ArkoNativeComposerMountOptions {
  root: Document
  accountKey: string | undefined
  scopeKey: string
  locked?: () => boolean
  onFeedback(message: string): void
}

export const inject: string[] = []

/** Registration alone never changes a document; the Arko page owns mount/dispose. */
export function apply(ctx: ClientContext): void {
  ctx.reflect.provide('arkoNativeComposer', mountArkoNativeEmojiPicker)
}

export function mountArkoNativeEmojiPicker(options: ArkoNativeComposerMountOptions) {
  if (options.root !== document) throw new Error('Arko 表情入口必须在所属页面内挂载')
  return installArkoNativeComposerAdapter({
    root: options.root,
    ...(options.locked === undefined ? {} : { locked: options.locked }),
    onFeedback: options.onFeedback,
    mountEmojiPicker(host: HTMLElement, controls: ArkoNativeComposerControls): ArkoNativeComposerPicker {
      const style = document.createElement('style')
      style.textContent = '[data-arkme-native-emoji] > [data-arkme-emoji-picker] { width: 100%; height: 100%; }'
        + '[data-arkme-native-emoji] [data-arkme-composer-tool="emoji"] { width: 100% !important; height: 100% !important; }'
      const seat = document.createElement('div')
      seat.dataset.arkmeNativeEmoji = ''
      seat.style.cssText = 'width:100%;height:100%'
      host.append(style, seat)
      const root = createRoot(seat)
      const render = (disabled: boolean) => root.render(<ArkmeEmojiPicker
        mode="text"
        disabled={disabled}
        accountKey={options.accountKey}
        scopeKey={options.scopeKey}
        getCaretGeometry={controls.getCaretGeometry}
        getEditorGeometry={controls.getEditorGeometry}
        onBeforeToggle={controls.captureSelection}
        onSelect={emoji => controls.insertText(emoji.unicode)}
        onError={options.onFeedback}
      />)
      render(controls.disabled)
      return {
        update: ({ disabled }) => { render(disabled) },
        dispose: () => { root.unmount(); seat.remove(); style.remove() },
      }
    },
  })
}
