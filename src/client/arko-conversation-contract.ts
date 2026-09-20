import type { ArkmeArkoModelCatalog } from '../types.js'

export interface ArkoConversationMessage {
  id: string
  /** Preserved by the business owner when a local message acquires a server ID. */
  presentationKey?: string
  messageId?: number
  sessionId?: number
  role: 'user' | 'assistant' | 'divider'
  text: string
  reasoning?: string
  status: 'sending' | 'done' | 'error'
  createdAtMillis?: number
  assistantMsgId?: number
  runUid?: string
  runStatus?: string
  messageActionRef?: string
  messageActionConversationRef?: string
  copyLinkAvailable?: boolean
  forwardAvailable?: boolean
}

export interface ArkoConversationSnapshot {
  accountKey: string
  displayName: string
  /** Business context, never used as the native presentation session identity. */
  sessionId?: number
  messages: readonly ArkoConversationMessage[]
  modelCatalog: ArkmeArkoModelCatalog | null
  loading: boolean
  busy: boolean
  draft: string
  error: string
  hasMore?: boolean
  historyError?: string
  inputBlockedReason?: string
  notice?: string
}

export interface ArkoConversationHistoryPage {
  messages: readonly ArkoConversationMessage[]
  hasMore: boolean
}

export interface ArkoConversationActions {
  submit(text: string): Promise<boolean>
  selectModel(routeKey: string): Promise<boolean | void>
  cancel(): Promise<boolean | void>
  loadEarlier(): Promise<ArkoConversationHistoryPage>
}

