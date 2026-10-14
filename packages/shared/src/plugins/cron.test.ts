import { describe, expect, it } from "vitest";
import { isPluginCronSchedule, latestPluginCronSlot, parsePluginCronSchedule, type PluginCronSchedule } from "./cron";
import { parsePluginManifest, pluginGrantAdditions, pluginGrantExpands, pluginGrantRequest } from "./manifest";

const at = (iso: string) => Date.parse(iso);
const slot = (expression: string, nowIso: string, lookbackMinutes = 24 * 60, timeZone = "Asia/Dhaka") => {
  const schedule = parsePluginCronSchedule(expression) as PluginCronSchedule;
  const found = latestPluginCronSlot(schedule, at(nowIso), { timeZone, lookbackMinutes });
  return found === null ? null : new Date(found).toISOString();
};

describe("plugin cron schedules", () => {
  it("parses the standard five-field syntax and rejects the rest", () => {
    for (const valid of ["* * * * *", "*/15 * * * *", "0 3 * * *", "0 9-17/2 * * mon-fri", "30 0 1,15 * *", "0 0 * jan,jul sun", "5/10 * * * 7"]) {
      expect(isPluginCronSchedule(valid), valid).toBe(true);
    }
    for (const invalid of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-1 * * * *", "a * * * *", "* * * * 8", "1/2/3 * * * *", ""]) {
      expect(typeof parsePluginCronSchedule(invalid), invalid).toBe("string");
    }
  });

  it("finds the latest slot at or before now in the store's wall clock", () => {
    // 03:00 in Dhaka is 21:00 UTC the day before.
    expect(slot("0 3 * * *", "2026-10-02T00:00:00.000Z")).toBe("2026-10-01T21:00:00.000Z");
    expect(slot("0 3 * * *", "2026-10-01T21:00:00.000Z")).toBe("2026-10-01T21:00:00.000Z");
    expect(slot("0 3 * * *", "2026-10-01T20:59:59.000Z")).toBe("2026-09-30T21:00:00.000Z");
    expect(slot("*/15 * * * *", "2026-10-02T10:07:30.000Z")).toBe("2026-10-02T10:00:00.000Z");
    expect(slot("* * * * *", "2026-10-02T10:07:30.000Z")).toBe("2026-10-02T10:07:00.000Z");
  });

  it("follows the store's daylight saving time", () => {
    // 03:00 in New York is 07:00 UTC in summer (EDT) and 08:00 UTC in winter (EST).
    expect(slot("0 3 * * *", "2026-07-01T12:00:00.000Z", 24 * 60, "America/New_York")).toBe("2026-07-01T07:00:00.000Z");
    expect(slot("0 3 * * *", "2026-01-15T12:00:00.000Z", 24 * 60, "America/New_York")).toBe("2026-01-15T08:00:00.000Z");
    // 02:30 does not exist on 2026-03-08 (02:00 → 03:00): the slot runs just after the gap.
    expect(slot("30 2 * * *", "2026-03-08T12:00:00.000Z", 24 * 60, "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    // 01:30 happens twice on 2026-11-01: the earlier one (EDT) runs.
    expect(slot("30 1 * * *", "2026-11-01T12:00:00.000Z", 24 * 60, "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("applies day-of-month OR day-of-week when both are restricted, AND otherwise", () => {
    // 2026-10-02 is a Friday; in Dhaka 09:00 Friday = 03:00 UTC.
    expect(slot("0 9 1 * fri", "2026-10-02T04:00:00.000Z")).toBe("2026-10-02T03:00:00.000Z");
    expect(slot("0 9 * * mon", "2026-10-02T04:00:00.000Z", 7 * 24 * 60)).toBe("2026-09-28T03:00:00.000Z");
    expect(slot("0 9 15 * *", "2026-10-02T04:00:00.000Z", 30 * 24 * 60)).toBe("2026-09-15T03:00:00.000Z");
  });

  it("returns null beyond the lookback window instead of searching forever", () => {
    expect(slot("0 0 1 1 *", "2026-10-02T00:00:00.000Z")).toBeNull();
    expect(slot("0 0 29 2 *", "2026-10-02T00:00:00.000Z", 366 * 24 * 60)).toBeNull();
    expect(slot("0 0 1 1 *", "2026-10-02T00:00:00.000Z", 366 * 24 * 60)).toBe("2025-12-31T18:00:00.000Z");
  });

  it("validates schedules in the manifest", () => {
    const base = { id: "acme.jobs", name: "Jobs", version: "1.0.0", apiVersion: "2026-10", description: "Runs jobs.", author: { name: "Acme" } };
    expect(parsePluginManifest({ ...base, cron: [{ name: "nightly", schedule: "0 3 * * *" }] }).ok).toBe(true);
    const bad = parsePluginManifest({ ...base, cron: [{ name: "nightly", schedule: "0 25 * * *" }] });
    expect(bad).toMatchObject({ ok: false, issues: [{ path: "cron.0.schedule" }] });
  });
});

describe("plugin grant additions", () => {
  const manifest = (overrides: Record<string, unknown>) => {
    const parsed = parsePluginManifest({
      id: "acme.loyalty", name: "Loyalty", version: "1.0.0", apiVersion: "2026-10", description: "Points.", author: { name: "Acme" },
      ...overrides,
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return pluginGrantRequest(parsed.manifest);
  };

  it("lists exactly what an update adds and nothing when it narrows", () => {
    const before = manifest({ scopes: ["read_orders"], events: ["order.*"], allowedHosts: ["api.acme.example"] });
    const after = manifest({ scopes: ["read_orders", "read_customers"], events: ["order.paid", "customer.created"], allowedHosts: ["api.acme.example"] });
    expect(pluginGrantExpands(before, after)).toBe(true);
    expect(pluginGrantAdditions(before, after)).toMatchObject({ scopes: ["read_customers"], events: ["customer.created"], allowedHosts: [] });
    const narrower = manifest({ events: ["order.paid"] });
    expect(pluginGrantExpands(before, narrower)).toBe(false);
    expect(Object.values(pluginGrantAdditions(before, narrower)).every((value) => value === false || (Array.isArray(value) && value.length === 0))).toBe(true);
    expect(pluginGrantAdditions(null, after)).toEqual(after);
  });
});
