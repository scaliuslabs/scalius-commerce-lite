// The API Worker's "#checkout-language-presets" (apps/api/wrangler.jsonc
// `alias`): the built-in English and Bangla checkout copy of
// packages/shared/src/checkout-language-presets.ts, parsed from a Text module
// (../generated/checkout-language-presets.gen.txt, `pnpm regen`) when the
// catalogue is first read, instead of 190 KiB of literals compiled at every
// isolate start. text-data.test.ts proves the copies equal the source.
import type {
  CheckoutLanguageData,
  ENGLISH_CHECKOUT_LANGUAGE_DATA as SourceEnglish,
} from "@scalius/shared/checkout-language-presets";
// A Text module: a string, not compiled at isolate start.
import presets from "../generated/checkout-language-presets.gen.txt";

export type { CheckoutLanguageData, CheckoutLanguageKey } from "@scalius/shared/checkout-language-presets";

const parsed = JSON.parse(presets) as { en: typeof SourceEnglish; bn: CheckoutLanguageData };

export const ENGLISH_CHECKOUT_LANGUAGE_DATA = parsed.en;
export const BANGLA_CHECKOUT_LANGUAGE_DATA: CheckoutLanguageData = parsed.bn;
