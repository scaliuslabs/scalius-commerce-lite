// Buyer-facing checkout copy the API itself must say (an app checkout depends
// on is down, an app's offer changed under the order), in the store default
// language's checkout copy with the merchant's edits (Settings → Checkout
// languages; MARKETS-DESIGN D9). Read only on those failure paths; any read
// failure falls back to the English default, so the refusal itself never fails.

import type { Database } from "@scalius/database/client";
import {
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  type CheckoutLanguageKey,
} from "@scalius/shared/checkout-language";
import { readCheckoutCopyForLocale } from "../translations";

export async function readCheckoutCopy(db: Database, key: CheckoutLanguageKey): Promise<string> {
  try {
    return (await readCheckoutCopyForLocale(db, null)).copy[key];
  } catch {
    return ENGLISH_CHECKOUT_LANGUAGE_DATA[key];
  }
}
