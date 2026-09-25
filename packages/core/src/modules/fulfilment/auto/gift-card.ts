// The gift-card fulfiller (Wave B §4.2): one card, one `issue` transaction and
// one `gift_card_issued` outbox row per unit, in the auto-fulfil batch after
// the ledger insert. B4 fills it by composing the gift-cards domain's public
// entry; until then gift-card lines have no fulfiller and keep failing closed.
import type { AutoFulfiller } from "../registry";

export const giftCardFulfiller: AutoFulfiller | null = null;
