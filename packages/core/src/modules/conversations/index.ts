// Conversations domain: buyer and store threads, messages, image attachments
// and support-request cases on the order thread (Wave A §4).
export * from "./browser";
export {
  assertBuyerOrderAccess,
  countBuyerUnread,
  createStoreThread,
  decodeConversationCursor,
  encodeConversationCursor,
  enqueueConversationNotifications,
  getBuyerThread,
  getOrCreateOrderThread,
  getStaffInboxSummary,
  getStaffOrderThread,
  getStaffThread,
  isVerifiedCustomerAccount,
  listBuyerThreads,
  listStaffInbox,
  markBuyerRead,
  markStaffRead,
  planConversationAppend,
  postBuyerOrderMessage,
  postConversationMessage,
  postStaffOrderMessage,
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
