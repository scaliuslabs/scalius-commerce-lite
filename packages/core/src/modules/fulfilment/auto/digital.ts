// The digital fulfiller (Wave B §3.3): entitlements for file assets, FIFO
// licence keys from the variant's pool, and the `order_digital_delivered`
// outbox row, all in the auto-fulfil batch after the ledger insert.
// B3 fills it by composing the digital domain's public entry; until then
// digital lines have no fulfiller and keep failing closed.
import type { AutoFulfiller } from "../registry";

export const digitalFulfiller: AutoFulfiller | null = null;
