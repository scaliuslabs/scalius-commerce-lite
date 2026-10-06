import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";
import { phoneCountryMeta } from "@scalius/shared/phone-example";
import { phoneHintCopy, phoneHints } from "./phone-hint";

const english = phoneHintCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA);
const bangla = phoneHintCopy(BANGLA_CHECKOUT_LANGUAGE_DATA);

describe("the phone field's words per country", () => {
  it("keeps today's exact Bangladesh text, with or without an example", () => {
    const expected = {
      hints: {
        delivery: "11-digit mobile number starting with 01. The courier calls this number.",
        pickup: "11-digit mobile number starting with 01. We call this number when your order is ready to pick up.",
        none: "11-digit mobile number starting with 01. We send your order updates to this number.",
      },
      placeholder: "01712-345678",
    };
    expect(phoneHints("BD", english, null)).toEqual(expected);
    expect(phoneHints("BD", english, phoneCountryMeta("BD"))).toEqual(expected);
  });

  it("asks for the country code in another country and shows its example", () => {
    expect(phoneHints("IN", english, phoneCountryMeta("IN"))).toEqual({
      hints: {
        delivery: "Include your country code. The courier calls this number. Example: +91 81234 56789",
        pickup: "Include your country code. We call this number when your order is ready to pick up. Example: +91 81234 56789",
        none: "Include your country code. We send your order updates to this number. Example: +91 81234 56789",
      },
      placeholder: "081234 56789",
    });
  });

  it("names no example when libphonenumber has none, and falls back to the label for the placeholder", () => {
    expect(phoneHints("IN", english, null)).toEqual({
      hints: {
        delivery: "Include your country code. The courier calls this number.",
        pickup: "Include your country code. We call this number when your order is ready to pick up.",
        none: "Include your country code. We send your order updates to this number.",
      },
      placeholder: "Phone number",
    });
  });

  it("speaks Bangla in both", () => {
    expect(phoneHints("IN", bangla, phoneCountryMeta("IN")).hints.delivery)
      .toBe("কান্ট্রি কোডসহ নম্বর লিখুন। কুরিয়ার এই নম্বরে কল করবে। উদাহরণ: +91 81234 56789");
    expect(phoneHints("BD", bangla, null).hints.delivery).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.customerPhoneHelp);
  });

  it("keeps every phone copy key within the 120 characters a checkout language text may hold", () => {
    for (const copy of [english, bangla]) {
      for (const key of ["help", "pickupHelp", "serviceHelp", "intlHelp", "intlPickupHelp", "intlServiceHelp", "exampleText"] as const) {
        expect(copy[key].length, key).toBeLessThanOrEqual(120);
      }
    }
  });
});
