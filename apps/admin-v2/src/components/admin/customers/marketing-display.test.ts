import { describe, expect, it } from "vitest";
import { CONSENT_BADGE, consentFacts, suggestedConsentChange, type ConsentView } from "./marketing-display";

const consent = (overrides: Partial<ConsentView>): ConsentView => ({
  channel: "email",
  status: "not_subscribed",
  state: null,
  contact: "a@example.com",
  source: null,
  subscribedAt: null,
  unsubscribedAt: null,
  requestedAt: null,
  updatedAt: null,
  ...overrides,
});

describe("marketing consent display", () => {
  it("maps every status to a badge tone (the word is always shown too)", () => {
    expect(CONSENT_BADGE).toEqual({ subscribed: "success", pending: "attention", unsubscribed: "secondary", not_subscribed: "outline" });
  });

  it("says where consent came from and when, for the status shown", () => {
    expect(consentFacts(consent({ status: "subscribed", state: "subscribed", source: "checkout", subscribedAt: "2026-10-02T04:00:00.000Z" })))
      .toEqual({ kind: "dated", source: "checkout", at: "2026-10-02T04:00:00.000Z" });
    expect(consentFacts(consent({ status: "pending", state: "pending", source: "newsletter", requestedAt: "2026-10-01T00:00:00.000Z" })))
      .toEqual({ kind: "dated", source: "newsletter", at: "2026-10-01T00:00:00.000Z" });
    expect(consentFacts(consent({ status: "unsubscribed", state: "unsubscribed", source: "link", updatedAt: "2026-09-01T00:00:00.000Z" })))
      .toEqual({ kind: "dated", source: "link", at: "2026-09-01T00:00:00.000Z" });
  });

  it("tells a missing address and consent for an earlier address apart from never asked", () => {
    expect(consentFacts(consent({ contact: null }))).toEqual({ kind: "no_contact" });
    expect(consentFacts(consent({ state: "subscribed" }))).toEqual({ kind: "other_address" });
    expect(consentFacts(consent({}))).toEqual({ kind: "none" });
  });

  it("suggests the change staff most likely want", () => {
    expect(suggestedConsentChange("subscribed")).toBe("unsubscribed");
    expect(suggestedConsentChange("pending")).toBe("unsubscribed");
    expect(suggestedConsentChange("unsubscribed")).toBe("subscribed");
    expect(suggestedConsentChange("not_subscribed")).toBe("subscribed");
  });
});
