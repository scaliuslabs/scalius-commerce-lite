// A delivery provider row's readiness, as the courier that reads it reports
// its blockers (every courier is an app's: the app's settings and status).
import { describe, expect, it } from "vitest";
import { getDeliveryProviderReadinessSummary } from "./provider-readiness";

describe("delivery provider readiness summary", () => {
  it("is ready only when the courier reports no blockers and the provider is on", () => {
    expect(getDeliveryProviderReadinessSummary({ type: "acme.parcel:parcel", activationBlockers: [], isActive: true }))
      .toMatchObject({ status: "ready", lifecycle: "active", configured: true, tested: true, active: true, issues: [] });
    expect(getDeliveryProviderReadinessSummary({ type: "acme.parcel:parcel", activationBlockers: [], isActive: false }))
      .toMatchObject({ status: "incomplete", lifecycle: "tested", active: false, issues: [{ code: "inactive" }] });
  });

  it("says the courier's own reason for a blocked setup", () => {
    const summary = getDeliveryProviderReadinessSummary({
      type: "acme.parcel:parcel",
      activationBlockers: [{ source: "config", key: "settings.api_key", label: "api_key", message: "Complete Parcel's settings: api_key." }],
      isActive: true,
    });
    expect(summary).toMatchObject({ status: "incomplete", lifecycle: "blocked", active: false });
    expect(summary.issues).toEqual([{ code: "unconfigured", message: "Complete Parcel's settings: api_key." }]);
  });

  it("fails closed for a type no courier answers for", () => {
    expect(getDeliveryProviderReadinessSummary({ type: "dhl", isActive: true })).toMatchObject({
      lifecycle: "blocked",
      active: false,
      activationBlockers: [{ key: "type", message: "Unsupported delivery provider type: dhl" }],
    });
  });

  it("reports secrets that cannot be read as an error, not unfinished setup", () => {
    expect(getDeliveryProviderReadinessSummary({ type: "acme.parcel:parcel", credentialsReadable: false, isActive: true })).toMatchObject({
      status: "error",
      lifecycle: "blocked",
      issues: [{ code: "unreadable", message: expect.stringContaining("cannot be decrypted") }],
    });
  });
});
