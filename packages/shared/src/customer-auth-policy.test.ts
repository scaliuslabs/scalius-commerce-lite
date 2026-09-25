import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOMER_IDENTITY,
  checkoutContactFields,
  customerIdentityProblem,
  isChannelCollected,
  normalizeCustomerIdentitySettings,
  offeredChannels,
  orderChannelTarget,
  orderCodeChannels,
  resolveSignInChannel,
} from "./customer-auth-policy";

describe("customer identity settings", () => {
  it("keeps a valid document and resets anything else to the defaults", () => {
    const saved = { email: "optional", whatsapp: "separate", channels: ["sms", "whatsapp", "sms"] };
    expect(normalizeCustomerIdentitySettings(saved)).toEqual({
      email: "optional",
      whatsapp: "separate",
      channels: ["sms", "whatsapp"],
    });
    for (const stale of [
      undefined,
      { authVerificationMethod: "sms_otp", policy: { otpChannels: ["sms"] } },
      { email: "optional", whatsapp: "off", channels: [] },
      { email: "hidden", whatsapp: "off", channels: ["email"] },
      { email: "maybe", whatsapp: "off", channels: ["sms"] },
    ]) {
      expect(normalizeCustomerIdentitySettings(stale)).toEqual(DEFAULT_CUSTOMER_IDENTITY);
    }
  });

  it("lets a channel be chosen only when its contact field is collected", () => {
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "email")).toBe(false);
    expect(isChannelCollected({ email: "optional", whatsapp: "off" }, "email")).toBe(true);
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "whatsapp")).toBe(false);
    expect(isChannelCollected({ email: "hidden", whatsapp: "same_as_phone" }, "whatsapp")).toBe(true);
    expect(isChannelCollected({ email: "hidden", whatsapp: "off" }, "sms")).toBe(true);
    expect(customerIdentityProblem({ email: "hidden", whatsapp: "off", channels: ["sms", "email"] }))
      .toBe("Email codes need checkout to ask for the email address.");
    expect(customerIdentityProblem({ email: "hidden", whatsapp: "off", channels: ["whatsapp"] }))
      .toBe("WhatsApp codes need checkout to ask for a WhatsApp number.");
    expect(customerIdentityProblem({ email: "required", whatsapp: "off", channels: [] }))
      .toBe("Choose at least one way to send codes.");
  });

  it("offers only chosen channels that can send, and never adds one (fail closed)", () => {
    const settings = { email: "required", whatsapp: "off", channels: ["email"] } as const;
    const chosen = { ...settings, channels: [...settings.channels] };
    expect(offeredChannels(chosen, { email: false, sms: true, whatsapp: true })).toEqual([]);
    expect(offeredChannels(chosen, { email: true, sms: true })).toEqual(["email"]);
  });

  it("resolves a sign-in channel from the chosen ones only", () => {
    expect(resolveSignInChannel(["email"], "phone", "sms")).toBeNull();
    expect(resolveSignInChannel(["email", "whatsapp", "sms"], "phone")).toBe("whatsapp");
    expect(resolveSignInChannel(["email", "whatsapp", "sms"], "phone", "sms")).toBe("sms");
    expect(resolveSignInChannel(["email", "sms"], "email", "sms")).toBe("email");
  });

  it("shapes the checkout contact fields; phone is never optional", () => {
    expect(checkoutContactFields({ email: "hidden", whatsapp: "same_as_phone" })).toEqual({ email: "hidden", whatsapp: "hidden" });
    expect(checkoutContactFields({ email: "required", whatsapp: "separate" })).toEqual({ email: "required", whatsapp: "optional" });
  });

  it("sends order codes only to contacts saved on the order", () => {
    const order = { customerPhone: "+8801712000001", customerEmail: " Buyer@Example.test ", customerWhatsapp: "+8801812000001" };
    expect(orderChannelTarget({ whatsapp: "separate" }, "whatsapp", order)).toBe("+8801812000001");
    expect(orderChannelTarget({ whatsapp: "same_as_phone" }, "whatsapp", order)).toBe("+8801712000001");
    expect(orderChannelTarget({ whatsapp: "separate" }, "whatsapp", { ...order, customerWhatsapp: null })).toBe("+8801712000001");
    expect(orderChannelTarget({ whatsapp: "off" }, "whatsapp", order)).toBeNull();
    expect(orderCodeChannels(
      { email: "optional", whatsapp: "off", channels: ["email", "sms"] },
      { ...order, customerEmail: null },
    )).toEqual([{ channel: "sms", target: "+8801712000001" }]);
    expect(orderCodeChannels({ email: "optional", whatsapp: "off", channels: ["email"] }, order))
      .toEqual([{ channel: "email", target: "buyer@example.test" }]);
  });
});
