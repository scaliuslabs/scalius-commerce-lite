// Conversations domain: buyer and store threads, messages, image attachments
// and support-request cases on the order thread (Wave A §4), and chat-channel
// threads a messaging app delivers (COMMERCE-HOOKS H18).
export * from "./browser";
export {
  assertBuyerOrderAccess,
  countBuyerUnread,
  createStoreThread,
  decodeConversationCursor,
  encodeConversationCursor,
  sendConversationNotifications,
  getBuyerThread,
  getOrCreateOrderThread,
  getStaffInboxSummary,
  getStaffOrderThread,
  getStaffThread,
  isVerifiedCustomerAccount,
  listBuyerThreads,
  listStaffInbox,
  queryStaffInbox,
  listConversationAssignees,
  replayConversationPost,
  markBuyerRead,
  markStaffRead,
  planConversationAppend,
  postBuyerOrderMessage,
  postConversationMessage,
  postStaffOrderMessage,
  readChannelContact,
  readOrderThread,
  readThread,
  resolveBuyerThread,
  updateStaffThread,
  type ConversationLine,
  type PostMessageInput,
  type PostMessageResult,
  type StaffInboxFilters,
  type ThreadRow,
} from "./threads";
export {
  resolveConversationAttachment,
  stageConversationAttachment,
  sweepOrphanConversationAttachments,
  type StagedAttachment,
} from "./attachments";
export {
  createCustomerOrderSupportRequest,
  createReceiptOrderSupportRequest,
  updateAdminOrderSupportRequestStatus,
  type CaseSubmitResult,
} from "./order-cases";

export {
  applyChannelReceipt,
  channelMessageBody,
  findChannelThread,
  receiveChannelMessage,
  storedChannelAttachments,
  type ChannelContact,
  type ChannelReceiveOutcome,
  type ReceiveChannelMessageInput,
} from "./channels";
export {
  CONVERSATION_PAGE_MAX,
  conversationMessageRepresentations,
  conversationRepresentations,
  listConversationMessageRows,
  listConversationRows,
  readConversationRepresentation,
} from "./representation";

export * from "./saved-replies";
export * from "./cart-share";
export { findConversationMessages } from "./search";
export { getConversationContext } from "./context";
