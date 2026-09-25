// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";
import {
  describeOrderCodeSendRefusal,
  formatCountdown,
  getOrderCodeFailureText,
  getOrderLookupFieldErrors,
  normalizeOrderReference,
  readOrderLookupInput,
} from "./order-lookup";

const en = ENGLISH_CHECKOUT_LANGUAGE_DATA;
const unavailable = en.trackOrderUnavailableText;

describe("order lookup input", () => {
  it("reads an order number however the buyer types it", () => {
    expect(normalizeOrderReference("#1001")).toBe("1001");
    expect(normalizeOrderReference(" # 1001 ")).toBe("1001");
    expect(normalizeOrderReference("১০০১")).toBe("1001");
    expect(normalizeOrderReference("JJEHCFQ3C1JJ35GX")).toBe("JJEHCFQ3C1JJ35GX");
  });

  it("rejects text that cannot be an order reference", () => {
    expect(normalizeOrderReference("")).toBeNull();
    expect(normalizeOrderReference("#12")).toBeNull();
    expect(normalizeOrderReference("<script>alert(1)</script>")).toBeNull();
    expect(normalizeOrderReference("1001; drop")).toBeNull();
  });

  it("accepts Bangladeshi phone formats, including Bangla digits", () => {
    expect(readOrderLookupInput("#1001", "০১৭১২-৩৪৫৬৭৮")).toEqual({
      ok: true,
      reference: "1001",
      phone: "+8801712345678",
    });
    expect(readOrderLookupInput("1001", "1712 345678")).toMatchObject({ ok: true, phone: "+8801712345678" });
  });

  it("names the field to fix, order number first", () => {
    expect(readOrderLookupInput("", "")).toEqual({ ok: false, field: "reference" });
    expect(readOrderLookupInput("1001", "0171234")).toEqual({ ok: false, field: "phone" });
    expect(readOrderLookupInput("1001", "01212345678")).toEqual({ ok: false, field: "phone" });
  });

  it("gives every field its own message at once", () => {
    expect(getOrderLookupFieldErrors(en, "", "")).toEqual({
      reference: en.trackOrderNumberInvalidText,
      phone: en.trackOrderPhoneInvalidText,
    });
    expect(getOrderLookupFieldErrors(BANGLA_CHECKOUT_LANGUAGE_DATA, "#1001", "0171234")).toEqual({
      phone: BANGLA_CHECKOUT_LANGUAGE_DATA.trackOrderPhoneInvalidText,
    });
    expect(getOrderLookupFieldErrors(en, "১০০১", "০১৭১২-৩৪৫৬৭৮")).toEqual({});
  });
});

describe("order code messages", () => {
  it("formats waits as minutes and seconds", () => {
    expect(formatCountdown(45)).toBe("0:45");
    expect(formatCountdown(120)).toBe("2:00");
    expect(formatCountdown(59.2)).toBe("1:00");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  it("says how long to wait when rate limited, without mentioning IPs", () => {
    const text = getOrderCodeFailureText(en, { status: 429, retryAfterSeconds: 120 }, "send", unavailable);
    expect(text).toBe("Try again in 2:00");
    expect(getOrderCodeFailureText(en, { status: 429 }, "verify", unavailable)).toBe(en.paymentRecoveryRateLimitedText);
    expect(getOrderCodeFailureText(en, { status: 429, message: "Too many codes.", retryAfterSeconds: 45 }, "send", unavailable))
      .toBe("Too many codes. Try again in 0:45.");
    expect(`${text} ${en.paymentRecoveryRateLimitedText}`).not.toMatch(/\bIP\b/);
  });

  it("counts the attempts left on a wrong code", () => {
    expect(getOrderCodeFailureText(en, { status: 400, attemptsLeft: 1 }, "verify", unavailable))
      .toBe("That code isn't right. 1 attempt left.");
    expect(getOrderCodeFailureText(en, { status: 400, attemptsLeft: 3 }, "verify", unavailable))
      .toBe("That code isn't right. 3 attempts left.");
    expect(getOrderCodeFailureText(en, { status: 400, attemptsLeft: 0 }, "verify", unavailable))
      .toBe("This code can't be used anymore. Send a new code.");
  });

  it("shows the API's reason when a send is refused for this order", () => {
    const notFound = "We couldn't find an order with that number and phone number. Check both and try again.";
    expect(getOrderCodeFailureText(en, { status: 404, message: notFound }, "send", unavailable)).toBe(notFound);
    expect(getOrderCodeFailureText(en, { status: 409, message: "No way to reach you." }, "send", unavailable)).toBe("No way to reach you.");
    expect(getOrderCodeFailureText(en, { status: 400, message: "Backend detail" }, "send", unavailable)).toBe(en.paymentRecoverySendFailedText);
  });

  it("uses the page's unavailable copy and generic send/verify failures otherwise", () => {
    expect(getOrderCodeFailureText(en, { status: 503 }, "send", unavailable)).toBe(unavailable);
    expect(getOrderCodeFailureText(en, { status: 502 }, "send", unavailable)).toBe(en.paymentRecoverySendFailedText);
    expect(getOrderCodeFailureText(en, { status: 400 }, "verify", unavailable)).toBe(en.paymentRecoveryVerificationFailedText);
  });

  it("speaks the active checkout language", () => {
    expect(getOrderCodeFailureText(BANGLA_CHECKOUT_LANGUAGE_DATA, { status: 400, attemptsLeft: 2 }, "verify", unavailable))
      .toBe("কোডটি সঠিক নয়। আর 2 বার চেষ্টা করতে পারবেন।");
    expect(getOrderCodeFailureText(BANGLA_CHECKOUT_LANGUAGE_DATA, { status: 429, retryAfterSeconds: 45 }, "send", unavailable))
      .toBe("0:45 পরে আবার চেষ্টা করুন");
  });
});

describe("refused order-code send", () => {
  it("keeps the code field open on a rate limit, with the wait on the resend button", () => {
    expect(describeOrderCodeSendRefusal(en, { status: 429, message: "A code was just sent. Please wait before asking for another.", retryAfterSeconds: 49 }, unavailable))
      .toEqual({ message: "A code was just sent. Please wait before asking for another.", codeSent: true, resendAfterSeconds: 49, needsStoreContact: false });
  });

  it("shows no code field when nothing could be sent", () => {
    expect(describeOrderCodeSendRefusal(en, { status: 503 }, unavailable))
      .toEqual({ message: unavailable, codeSent: false, resendAfterSeconds: 0, needsStoreContact: true });
    expect(describeOrderCodeSendRefusal(en, { status: 404, message: "No such order." }, unavailable))
      .toEqual({ message: "No such order.", codeSent: false, resendAfterSeconds: 0, needsStoreContact: false });
  });
});
