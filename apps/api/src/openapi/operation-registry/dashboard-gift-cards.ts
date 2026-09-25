// Agent operation registry rows for the dashboard gift-card routes (Wave B §7.2).
// Reads are executable for staff agents; every write issues or moves stored
// value, or returns a bearer code, so it stays in the dashboard with a person.
import type { OperationRegistryEntry } from "./entry";

const MONEY_WRITE_REASON =
  "Gift cards are stored value: issuing, adjusting, disabling or re-sending one is a staff decision made in the dashboard, and issue returns a bearer code once.";

export const DASHBOARD_GIFT_CARD_OPERATIONS = {
  "dashboard.gift_cards.adjust": { exposure: "excluded", reason: MONEY_WRITE_REASON },
  "dashboard.gift_cards.create": { exposure: "excluded", sensitive: true, reason: MONEY_WRITE_REASON },
  "dashboard.gift_cards.get": {},
  "dashboard.gift_cards.list": {},
  "dashboard.gift_cards.resend": { exposure: "excluded", reason: MONEY_WRITE_REASON },
  "dashboard.gift_cards.summary": {},
  "dashboard.gift_cards.update": { exposure: "excluded", reason: MONEY_WRITE_REASON },
} satisfies Record<string, OperationRegistryEntry>;
