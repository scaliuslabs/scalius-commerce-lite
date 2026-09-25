// Browser-safe entry: pure types and policies only (no database, no provider
// SDKs, no domain index). Safe to import from the dashboard and from any domain.
export {
  CONVERSATION_LIMITS,
  CONVERSATION_STATUSES,
  CONVERSATION_SUBJECT_TYPES,
  CONVERSATION_ATTACHMENT_UPLOAD_TYPES,
  conversationUnreadCount,
  isConversationAttachmentId,
  isConversationId,
  normalizeConversationBody,
  normalizeConversationSubject,
  type ConversationAuthorType,
  type ConversationMessageKind,
  type ConversationMessageVisibility,
  type ConversationStatus,
  type ConversationSubjectType,
} from "@scalius/shared/conversation";
export * from "./projection";
export * from "./types";
