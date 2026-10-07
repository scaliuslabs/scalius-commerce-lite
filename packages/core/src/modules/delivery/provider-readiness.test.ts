// A delivery provider row's readiness, as the courier that reads it reports
// its blockers (every courier is an app's: the app's settings and status).
import { describe, expect, it } from "vitest";
import { getDeliveryProviderReadinessSummary } from "./provider-readiness";
import { createCourierProviders, retiredCourierReason } from "./couriers/registry";

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

describe("retired built-in couriers", () => {
  const row = {
    id: "dp_1", type: "pathao", isActive: true, credentials: "enc:v1:old", config: "{}",
    lastTestAttemptAt: null, lastTestSuccessAt: null, lastTestFailureAt: null, lastTestSuccessFingerprint: null,
  };

  it("read as blocked with the pack's reason, and never book or track, while the Bangladesh pack is not active", async () => {
    const pathao = createCourierProviders().get("pathao")!;
    expect(pathao).toMatchObject({ id: "pathao", label: "Pathao", countries: ["BD"] });
    const setup = await pathao.setup(row, "key");
    expect(setup).toMatchObject({ settings: null, error: "Activate Bangladesh pack in Apps to use it." });
    expect(setup.readiness).toMatchObject({ active: false, issues: [{ code: "unconfigured", message: retiredCourierReason() }] });
    await expect(pathao.createShipment({} as never, {} as never)).rejects.toMatchObject({ category: "misconfigured", message: "Pathao: Activate Bangladesh pack in Apps to use it." });
    await expect(pathao.trackShipment({ externalId: "DL1" }, {} as never)).rejects.toMatchObject({ category: "misconfigured" });
    expect(createCourierProviders().get("steadfast")?.label).toBe("Steadfast");
    expect(createCourierProviders().get("redx")).toBeUndefined();
  });

  it("resolve to the pack's courier once it is active", () => {
    const appPathao = { id: "scalius.bangladesh:pathao", label: "Pathao" } as never;
    expect(createCourierProviders([appPathao]).get("pathao")).toBe(appPathao);
    expect(createCourierProviders([appPathao]).get("scalius.bangladesh:pathao")).toBe(appPathao);
  });
});
