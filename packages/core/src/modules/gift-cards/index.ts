// Gift-cards domain: codes (HMAC lookup + ciphertext), the append-only
// balance ledger, issue, redemption as a checkout tender, release and refund
// credits (Wave B design §4). A LEAF domain: it imports only
// @scalius/database, @scalius/shared and core utils, never another domain.
// Stubs until B4 fills them.
export * from "./browser";
export type { LineExtrasInput } from "../../utils/line-extras";
export { countBuyerGiftCards, listLineIssuedCards } from "./extras";
