import { describe, expect, it } from "vitest";

import { BD_MOBILE_REQUIRED_MESSAGE, formatBdMobile, normalizeBdMobile, toLatinDigits } from "./phone-input";
import { validateAndFormatPhone } from "./customer-utils";

describe("phone input rules", () => {
  it("reads Bangla and Arabic-Indic digits as Latin digits", () => {
    expect(toLatinDigits("০১৭১২৩৪৫৬৭৮")).toBe("01712345678");
    expect(toLatinDigits("٠١٧")).toBe("017");
    expect(toLatinDigits("abc-12")).toBe("abc-12");
  });

  it.each([
    ["01712345678", "+8801712345678"],
    ["০১৮১২৩৪৫৬৭৮", "+8801812345678"],
    ["+880 1812-345678", "+8801812345678"],
    ["8801912345678", "+8801912345678"],
    ["1712 345 678", "+8801712345678"],
  ])("accepts the Bangladesh mobile %s", (raw, e164) => {
    expect(normalizeBdMobile(raw)).toBe(e164);
  });

  it.each(["02123456789", "01212345678", "0171234567", "017123456789", ""])(
    "rejects %s, which is not a Bangladesh mobile number",
    (raw) => {
      expect(normalizeBdMobile(raw)).toBeNull();
    },
  );

  it("shows mobile numbers the way buyers read them out", () => {
    expect(formatBdMobile("+8801712345678")).toBe("01712-345678");
    expect(formatBdMobile("+14155550100")).toBe("+14155550100");
  });

  it.each(["01212345678", "02123456789", "+880 2 9123456", "8802912345678"])(
    "refuses the non-mobile Bangladesh number %s everywhere with one message",
    (raw) => {
      expect(() => validateAndFormatPhone(raw)).toThrow(BD_MOBILE_REQUIRED_MESSAGE);
    },
  );

  it("still accepts other countries' numbers", () => {
    expect(validateAndFormatPhone("+14155550100")).toBe("+14155550100");
  });

  it("lets the server accept a number typed in Bangla digits", () => {
    expect(validateAndFormatPhone("০১৭১২৩৪৫৬৭৮")).toBe("+8801712345678");
  });
});
