// Nagad's value formats: amounts in paisa without floats, Dhaka time, statuses.

import { describe, expect, it } from "vitest";
import { dhakaDateTime, nagadOutcome, parseAmountMinor } from "./nagad";

describe("Nagad values", () => {
  it("parses decimal amounts into exact paisa", () => {
    const cases: Array<[string, number | null]> = [
      ["125.50", 12_550],
      ["125.5", 12_550],
      ["125", 12_500],
      ["0.01", 1],
      ["125.500", 12_550],
      ["0019.99", 1_999],
      [" 10.00 ", 1_000],
      ["125.505", null],
      ["-1.00", null],
      ["1e3", null],
      ["12,500.00", null],
      ["", null],
      ["99999999999999.00", null],
    ];
    for (const [amount, minor] of cases) expect(parseAmountMinor(amount), amount).toBe(minor);
  });

  it("formats yyyyMMddHHmmss in Asia/Dhaka (UTC+6), across a date change", () => {
    expect(dhakaDateTime(new Date("2026-10-03T18:30:05Z"))).toBe("20261004003005");
    expect(dhakaDateTime(new Date("2026-01-01T00:00:00Z"))).toBe("20260101060000");
  });

  it("reads Success as paid, Aborted/Cancelled as cancelled, failures as failed, anything else as not final", () => {
    expect(nagadOutcome("Success")).toBe("paid");
    expect(nagadOutcome("Aborted")).toBe("cancelled");
    expect(nagadOutcome("Cancelled")).toBe("cancelled");
    expect(nagadOutcome("Failed")).toBe("failed");
    expect(nagadOutcome("UnKnownFailed")).toBe("failed");
    expect(nagadOutcome("InvalidRequest")).toBe("failed");
    for (const status of ["Ready", "OrderInitiated", "InProgress", "Pending", "Successful?"]) expect(nagadOutcome(status), status).toBe("pending");
  });
});
