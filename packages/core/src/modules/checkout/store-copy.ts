// Buyer-facing checkout copy the API itself must say (an app checkout depends
// on is down, an app's offer changed under the order), in the store's active
// checkout language with the merchant's edits (Settings → Checkout
// languages). Read only on those failure paths; any read failure falls back
// to the English default, so the refusal itself never fails.

import type { Database } from "@scalius/database/client";
import { checkoutLanguages } from "@scalius/database/schema";
import {
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
  resolveCheckoutLanguageData,
  type CheckoutLanguageKey,
} from "@scalius/shared/checkout-language";
import { and, eq, isNull } from "drizzle-orm";

export async function readCheckoutCopy(db: Database, key: CheckoutLanguageKey): Promise<string> {
  try {
    const [active] = await db.select({ code: checkoutLanguages.code, languageData: checkoutLanguages.languageData })
      .from(checkoutLanguages)
      .where(and(eq(checkoutLanguages.isActive, true), isNull(checkoutLanguages.deletedAt)))
      .limit(1);
    return active ? resolveCheckoutLanguageData(active.code, active.languageData)[key] : ENGLISH_CHECKOUT_LANGUAGE_DATA[key];
  } catch {
    return ENGLISH_CHECKOUT_LANGUAGE_DATA[key];
  }
}
