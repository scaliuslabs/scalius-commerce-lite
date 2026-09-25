// Gift-cards domain: codes (HMAC lookup + ciphertext), the append-only
// balance ledger, issue, redemption as a checkout tender, release and refund
// credits (Wave B design §4). A LEAF domain: it imports only
// @scalius/database, @scalius/shared and core utils/errors, never another
// domain. Outbox rows are built by callers; settings are passed in.
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export { countBuyerGiftCards, listLineIssuedCards } from "./extras";
export {
    GIFT_CARDS_UNAVAILABLE_MESSAGE,
    GiftCardsUnavailableError,
    decryptGiftCardCode,
    deriveGiftCardKeys,
    requireGiftCardKey,
    type GiftCardKeys,
} from "./crypto";
export {
    GIFT_CARD_APPLY_HANDLE_MAX_LENGTH,
    GIFT_CARD_APPLY_HANDLE_TTL_SECONDS,
    openGiftCardApplyHandle,
    sealGiftCardApplyHandle,
} from "./apply-handle";
export {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardRedemptionStatements,
    buildGiftCardRefundStatement,
    buildGiftCardReleaseStatements,
    buildGiftCardTransactionInsert,
    buildGiftCardTransactionInsertOnce,
    giftCardIdsForTenderPayments,
    giftCardRedeemKey,
    giftCardReleaseKey,
    isGiftCardIdempotencyConflict,
    isGiftCardLedgerError,
    listHeldGiftCardTenders,
    newGiftCardTransactionId,
    type GiftCardRedemption,
    type HeldGiftCardTender,
} from "./ledger";
export {
    GIFT_CARD_MAX_AMOUNT_MINOR,
    buildGiftCardIssueStatements,
    buildStoreCreditGiftCardStatements,
    giftCardExpiryFromMonths,
    issueManualGiftCard,
    normalizeGiftCardMessage,
    normalizeGiftCardRecipient,
    storeCreditGiftCardId,
    type GiftCardIssueInput,
    type GiftCardRecipient,
    type ManualGiftCardInput,
    type ManualGiftCardResult,
} from "./issue";
export {
    GIFT_CARD_CHANGED_CODE,
    GIFT_CARD_CHANGED_MESSAGE,
    GIFT_CARD_NOT_FOUND_CODE,
    GIFT_CARD_UNUSABLE_CODE,
    GIFT_CARD_UNUSABLE_MESSAGE,
    GiftCardChangedError,
    GiftCardNotFoundError,
    GiftCardUnusableError,
    applyGiftCardCode,
    checkGiftCardBalance,
    findGiftCardByCode,
    giftCardUsability,
    isGiftCardExpired,
    quoteGiftCardTender,
    resolveGiftCardTenderCards,
    type AppliedGiftCard,
    type GiftCardBalance,
    type GiftCardTenderQuote,
    type GiftCardTenderResolution,
    type ResolvedTenderCard,
} from "./tender";
export {
    GIFT_CARD_LIST_FILTERS,
    adjustGiftCardBalance,
    getGiftCardForStaff,
    getStaffGiftCardSummary,
    giftCardLiabilitySummary,
    listGiftCardLast4,
    listGiftCardsForStaff,
    updateGiftCardForStaff,
    type GiftCardListFilter,
    type StaffGiftCardDetail,
    type StaffGiftCardSummary,
    type StaffGiftCardTransaction,
} from "./admin";
export {
    GIFT_CARD_SAVE_FAILED_CODE,
    GiftCardSaveFailedError,
    listBuyerGiftCards,
    revealBuyerGiftCardCode,
    saveGiftCardToAccount,
    type BuyerGiftCard,
    type BuyerGiftCardTransaction,
} from "./buyer";
export { resolveGiftCardIssuedMessage, type GiftCardIssuedMessage } from "./notification";
export { maskGiftCardContact, maskGiftCardRecipient } from "./mask";
