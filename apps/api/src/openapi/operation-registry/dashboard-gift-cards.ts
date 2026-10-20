// Agent operation registry rows for the dashboard gift-card routes (Wave B §7.2).
// Every write issues or moves stored value, or sends a bearer code, so each
// is financial risk (Full automation or a Custom grant with financial risk)
// and confirmation-gated. Issue returns the full code once: the agent result
// redacts it (staff and the recipient receive it), and the card is verified
// through gift_cards.list / get, which show the last four characters.
import type { OperationRegistryEntry } from "./entry";

const storedValue = (overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry => ({
  risk: "financial",
  confirmation: "required",
  batch: "forbidden",
  ...overrides,
});

export const DASHBOARD_GIFT_CARD_OPERATIONS = {
  "dashboard.gift_cards.adjust": storedValue(),
  "dashboard.gift_cards.create": storedValue({ sensitive: true }),
  "dashboard.gift_cards.get": {},
  "dashboard.gift_cards.list": {},
  "dashboard.gift_cards.resend": storedValue(),
  // The daily cap on what apps add (security audit S2): no app may raise its own.
  "dashboard.gift_cards.settings_get": { stability: "internal" },
  "dashboard.gift_cards.settings_update": storedValue({ stability: "internal" }),
  "dashboard.gift_cards.summary": {},
  "dashboard.gift_cards.update": storedValue(),
} satisfies Record<string, OperationRegistryEntry>;
