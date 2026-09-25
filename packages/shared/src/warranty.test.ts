import { describe, expect, it } from "vitest";

import {
  isWarrantyActive,
  isWarrantyDurationUnit,
  isWarrantyDurationValue,
  isWarrantyReplacementDays,
  OPEN_WARRANTY_CLAIM_STATUSES,
  WARRANTY_CLAIM_RESOLUTIONS,
  WARRANTY_CLAIM_STATUSES,
  WARRANTY_DURATION_UNITS,
  warrantyDurationLabel,
  warrantyDurationModifier,
  warrantyExpiresAt,
  warrantyReplacementUntil,
  warrantySummaryLabel,
  type WarrantyDurationUnit,
} from "./warranty";

const utc = (iso: string) => Date.parse(`${iso}Z`) / 1000;
const iso = (epochSeconds: number) => new Date(epochSeconds * 1000).toISOString().replace(".000Z", "");

describe("warranty vocabulary", () => {
  it("stores units as SQLite modifier words and bounds the policy fields", () => {
    expect(WARRANTY_DURATION_UNITS).toEqual(["days", "months", "years"]);
    expect(warrantyDurationModifier(12, "months")).toBe("+12 months");
    expect(isWarrantyDurationUnit("weeks")).toBe(false);
    expect([1, 120].every(isWarrantyDurationValue)).toBe(true);
    expect([0, 121, 1.5].some(isWarrantyDurationValue)).toBe(false);
    expect([0, 90].every(isWarrantyReplacementDays)).toBe(true);
    expect([-1, 91].some(isWarrantyReplacementDays)).toBe(false);
  });

  it("has the claim statuses and resolutions", () => {
    expect(WARRANTY_CLAIM_STATUSES).toEqual(["open", "in_progress", "resolved", "rejected"]);
    expect(OPEN_WARRANTY_CLAIM_STATUSES).toEqual(["open", "in_progress"]);
    expect(WARRANTY_CLAIM_RESOLUTIONS).toEqual(["repair", "replacement", "refund", "other"]);
  });
});

describe("warrantyExpiresAt", () => {
  it("adds days as exact seconds", () => {
    expect(iso(warrantyExpiresAt(utc("2026-02-20T10:30:15"), 10, "days"))).toBe("2026-03-02T10:30:15");
  });

  it("overflows a missing month-end day into the next month, like SQLite", () => {
    expect(iso(warrantyExpiresAt(utc("2025-01-31T12:00:00"), 1, "months"))).toBe("2025-03-03T12:00:00");
    expect(iso(warrantyExpiresAt(utc("2024-01-31T12:00:00"), 1, "months"))).toBe("2024-03-02T12:00:00");
    expect(iso(warrantyExpiresAt(utc("2025-03-31T00:00:00"), 1, "months"))).toBe("2025-05-01T00:00:00");
    expect(iso(warrantyExpiresAt(utc("2024-02-29T08:00:00"), 1, "years"))).toBe("2025-03-01T08:00:00");
    expect(iso(warrantyExpiresAt(utc("2024-02-29T08:00:00"), 4, "years"))).toBe("2028-02-29T08:00:00");
    expect(iso(warrantyExpiresAt(utc("2025-11-30T23:59:59"), 3, "months"))).toBe("2026-03-02T23:59:59");
    expect(iso(warrantyExpiresAt(utc("2026-09-25T00:00:00"), 120, "months"))).toBe("2036-09-25T00:00:00");
  });

  it("equals SQLite unixepoch(start, 'unixepoch', '+N unit') across month ends, leap years and every bound", async () => {
    const sqlite = await openSqlite();
    const statement = sqlite.prepare("SELECT unixepoch(CAST(? AS INTEGER), 'unixepoch', ?) AS expires");
    const starts = [
      "2024-01-29T00:00:00", "2024-01-30T06:00:00", "2024-01-31T23:59:59", "2024-02-28T12:00:00",
      "2024-02-29T12:00:00", "2024-03-31T01:02:03", "2024-05-31T00:00:00", "2024-08-31T18:45:00",
      "2024-10-31T00:00:01", "2024-12-31T23:59:59", "2025-01-31T09:00:00", "2025-02-28T00:00:00",
      "2025-12-31T00:00:00", "2026-09-25T14:07:09", "2027-11-30T00:00:00", "2099-12-31T23:59:59",
      "1970-01-01T00:00:00",
    ].map(utc);
    const random = seededRandom(0xa11);
    for (let index = 0; index < 200; index += 1) starts.push(Math.floor(random() * 4_102_444_800)); // up to 2100
    const cases: [number, WarrantyDurationUnit][] = [];
    for (const unit of WARRANTY_DURATION_UNITS) for (const value of [1, 2, 3, 6, 11, 12, 13, 18, 24, 59, 60, 119, 120]) cases.push([value, unit]);
    for (const start of starts) {
      for (const [value, unit] of cases) {
        const row = statement.get(start, warrantyDurationModifier(value, unit)) as { expires: number };
        expect(warrantyExpiresAt(start, value, unit), `${iso(start)} ${warrantyDurationModifier(value, unit)}`).toBe(row.expires);
      }
    }
    sqlite.close();
  });

  it("rejects fractional or negative inputs", () => {
    expect(() => warrantyExpiresAt(1.5, 1, "days")).toThrow(RangeError);
    expect(() => warrantyExpiresAt(-1, 1, "days")).toThrow(RangeError);
    expect(() => warrantyExpiresAt(0, 1.5, "months")).toThrow(RangeError);
  });
});

describe("warrantyReplacementUntil and isWarrantyActive", () => {
  it("adds replacement days, null without a window", () => {
    const start = utc("2026-09-25T10:00:00");
    expect(warrantyReplacementUntil(start, 7)).toBe(start + 7 * 86_400);
    expect(warrantyReplacementUntil(start, 0)).toBe(start);
    expect(warrantyReplacementUntil(start, null)).toBeNull();
  });

  it("is active until expiry and never when voided", () => {
    expect(isWarrantyActive({ expiresAt: 100, voidedAt: null }, 99)).toBe(true);
    expect(isWarrantyActive({ expiresAt: 100, voidedAt: null }, 100)).toBe(false);
    expect(isWarrantyActive({ expiresAt: 100, voidedAt: 50 }, 60)).toBe(false);
  });
});

describe("warranty labels", () => {
  it("pluralizes the duration", () => {
    expect(warrantyDurationLabel(1, "years")).toBe("1 year");
    expect(warrantyDurationLabel(18, "months")).toBe("18 months");
    expect(warrantyDurationLabel(1, "days")).toBe("1 day");
  });

  it("builds the buyer trust line", () => {
    expect(warrantySummaryLabel({ durationValue: 1, durationUnit: "years", provider: "brand", replacementDays: 7 }))
      .toBe("1 year brand warranty · 7-day replacement");
    expect(warrantySummaryLabel({ durationValue: 6, durationUnit: "months", provider: "store", replacementDays: null }))
      .toBe("6 months store warranty");
    expect(warrantySummaryLabel({ durationValue: 6, durationUnit: "months", provider: "store", replacementDays: 0 }))
      .toBe("6 months store warranty");
  });
});

interface SqliteDatabase {
  prepare(sql: string): { get(...values: unknown[]): unknown };
  close(): void;
}

/** Node 24's built-in SQLite, loaded by a runtime specifier so the Workers typecheck needs no Node types. */
async function openSqlite(): Promise<SqliteDatabase> {
  const specifier = "node:sqlite";
  const module = (await import(/* @vite-ignore */ specifier)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  return new module.DatabaseSync(":memory:");
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
