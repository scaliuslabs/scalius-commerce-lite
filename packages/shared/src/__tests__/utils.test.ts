import { describe, it, expect, vi } from "vitest";

// ─────────────────────────────────────────
// cn()
// ─────────────────────────────────────────
describe("cn()", () => {
  it("should combine multiple class names", async () => {
    const { cn } = await import("../utils");
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("should merge conflicting Tailwind classes", async () => {
    const { cn } = await import("../utils");
    // tailwind-merge should keep only the last conflicting class
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("should handle conditional classes", async () => {
    const { cn } = await import("../utils");
    expect(cn("base", false && "hidden", "visible")).toBe("base visible");
  });

  it("should handle undefined and null inputs", async () => {
    const { cn } = await import("../utils");
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });

  it("should handle empty arguments", async () => {
    const { cn } = await import("../utils");
    expect(cn()).toBe("");
  });

  it("should handle arrays of class names", async () => {
    const { cn } = await import("../utils");
    expect(cn(["foo", "bar"])).toBe("foo bar");
  });

  it("should merge complex Tailwind conflicts", async () => {
    const { cn } = await import("../utils");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });
});

// ─────────────────────────────────────────
// unixToDate()
// ─────────────────────────────────────────
describe("unixToDate()", () => {
  it("should convert a Unix timestamp in seconds to a Date", async () => {
    const { unixToDate } = await import("../utils");
    // 1700000000 seconds = 2023-11-14T22:13:20.000Z
    const result = unixToDate(1700000000);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1700000000000);
  });

  it("should handle a JavaScript millisecond timestamp", async () => {
    const { unixToDate } = await import("../utils");
    const ms = 1700000000000; // already milliseconds (13 digits)
    const result = unixToDate(ms);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1700000000000);
  });

  it("should convert a string timestamp", async () => {
    const { unixToDate } = await import("../utils");
    const result = unixToDate("1700000000");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(1700000000000);
  });

  it("should return the same Date when given a Date object", async () => {
    const { unixToDate } = await import("../utils");
    const date = new Date("2023-11-14T22:13:20.000Z");
    const result = unixToDate(date);
    expect(result).toBe(date);
  });

  it("should return null for null input", async () => {
    const { unixToDate } = await import("../utils");
    expect(unixToDate(null)).toBeNull();
  });

  it("should return null for undefined input", async () => {
    const { unixToDate } = await import("../utils");
    expect(unixToDate(undefined)).toBeNull();
  });

  it("should return null for NaN-producing string input", async () => {
    const { unixToDate } = await import("../utils");
    expect(unixToDate("not-a-number")).toBeNull();
  });

  it("should handle zero as a valid Unix timestamp", async () => {
    const { unixToDate } = await import("../utils");
    // 0 seconds = epoch
    const result = unixToDate(0);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(0);
  });

  it("should handle small timestamps as seconds", async () => {
    const { unixToDate } = await import("../utils");
    // 100 seconds
    const result = unixToDate(100);
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(100000);
  });
});

// ─────────────────────────────────────────
// formatDate()
// ─────────────────────────────────────────
describe("formatDate()", () => {
  it("should return 'N/A' for null", async () => {
    const { formatDate } = await import("../utils");
    expect(formatDate(null)).toBe("N/A");
  });

  it("should return 'N/A' for undefined", async () => {
    const { formatDate } = await import("../utils");
    expect(formatDate(undefined)).toBe("N/A");
  });

  it("should format a valid Date object", async () => {
    const { formatDate } = await import("../utils");
    const date = new Date("2023-11-14T22:13:20.000Z");
    const result = formatDate(date);
    // Should contain the year 2023 and "Nov" (day may vary by timezone)
    expect(result).toContain("2023");
    expect(result).toContain("Nov");
    expect(result).not.toBe("N/A");
    expect(result).not.toBe("Invalid date");
  });

  it("should format a Unix timestamp number", async () => {
    const { formatDate } = await import("../utils");
    const result = formatDate(1700000000);
    expect(result).toContain("2023");
    expect(result).toContain("Nov");
  });

  it("should format a string timestamp", async () => {
    const { formatDate } = await import("../utils");
    const result = formatDate("1700000000");
    expect(result).toContain("2023");
    expect(result).toContain("Nov");
  });

  it("should return 'Invalid date' for an invalid Date object", async () => {
    const { formatDate } = await import("../utils");
    expect(formatDate(new Date("invalid"))).toBe("Invalid date");
  });

  it("should return 'Invalid date' for a non-parseable string", async () => {
    const { formatDate } = await import("../utils");
    // NaN string results in unixToDate returning null
    expect(formatDate("not-a-date")).toBe("Invalid date");
  });
});

// ─────────────────────────────────────────
// getStatusBadgeClass()
// ─────────────────────────────────────────
describe("getStatusBadgeClass()", () => {
  it("should return amber classes for 'pending'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("pending");
    expect(badgeClass).toContain("bg-amber-50");
    expect(badgeClass).toContain("text-amber-700");
  });

  it("should return blue classes for 'processing'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("processing");
    expect(badgeClass).toContain("bg-blue-50");
    expect(badgeClass).toContain("text-blue-700");
  });

  it("should return indigo classes for 'confirmed'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("confirmed");
    expect(badgeClass).toContain("bg-indigo-50");
  });

  it("should return violet classes for 'shipped'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("shipped");
    expect(badgeClass).toContain("bg-violet-50");
  });

  it("should return emerald classes for 'delivered'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("delivered");
    expect(badgeClass).toContain("bg-emerald-50");
  });

  it("should return red classes for 'cancelled'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("cancelled");
    expect(badgeClass).toContain("bg-red-50");
  });

  it("should return rose classes for 'returned'", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("returned");
    expect(badgeClass).toContain("bg-rose-50");
  });

  it("should return muted classes for unknown statuses", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const { badgeClass } = getStatusBadgeClass("unknown");
    expect(badgeClass).toContain("bg-muted");
    expect(badgeClass).toContain("text-muted-foreground");
  });

  it("should be case-insensitive", async () => {
    const { getStatusBadgeClass } = await import("../utils");
    const lower = getStatusBadgeClass("pending");
    const upper = getStatusBadgeClass("PENDING");
    const mixed = getStatusBadgeClass("Pending");
    expect(lower).toEqual(upper);
    expect(lower).toEqual(mixed);
  });
});

// ─────────────────────────────────────────
// DEFAULT_CURRENCY
// ─────────────────────────────────────────
describe("DEFAULT_CURRENCY", () => {
  it("should have BDT as the default currency code", async () => {
    const { DEFAULT_CURRENCY } = await import("../currency");
    expect(DEFAULT_CURRENCY.code).toBe("BDT");
  });

  it("should have the Taka symbol", async () => {
    const { DEFAULT_CURRENCY } = await import("../currency");
    expect(DEFAULT_CURRENCY.symbol).toBe("\u09F3");
  });

  it("should have a numeric exchange rate", async () => {
    const { DEFAULT_CURRENCY } = await import("../currency");
    expect(typeof DEFAULT_CURRENCY.usdExchangeRate).toBe("number");
    expect(DEFAULT_CURRENCY.usdExchangeRate).toBe(1);
  });
});

// ─────────────────────────────────────────
// generateOrderId()
// ─────────────────────────────────────────
describe("generateOrderId()", () => {
  it("should return a string of length 6", async () => {
    const { generateOrderId } = await import("../order-utils");
    const id = generateOrderId();
    expect(id).toHaveLength(6);
  });

  it("should contain only uppercase letters and digits", async () => {
    const { generateOrderId } = await import("../order-utils");
    for (let i = 0; i < 50; i++) {
      const id = generateOrderId();
      expect(id).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it("should generate unique IDs across multiple calls", async () => {
    const { generateOrderId } = await import("../order-utils");
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateOrderId());
    }
    // With 36^6 possible values, 100 IDs should be overwhelmingly unique
    expect(ids.size).toBeGreaterThan(90);
  });
});

// ─────────────────────────────────────────
// standardizePhoneNumber() + phoneNumberSchema
// ─────────────────────────────────────────
describe("standardizePhoneNumber()", () => {
  it("should keep already-standard numbers as-is", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(standardizePhoneNumber("01712345678")).toBe("01712345678");
  });

  it("should strip +880 country code", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(standardizePhoneNumber("+8801712345678")).toBe("01712345678");
  });

  it("should strip 880 country code without +", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(standardizePhoneNumber("8801712345678")).toBe("01712345678");
  });

  it("should strip spaces and dashes", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(standardizePhoneNumber("+880 1712-345678")).toBe("01712345678");
  });

  it("should add leading 0 when starting with 1", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(standardizePhoneNumber("1712345678")).toBe("01712345678");
  });

  it("should throw for invalid phone number format", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(() => standardizePhoneNumber("12345")).toThrow(
      "Invalid phone number format",
    );
  });

  it("should throw for empty string", async () => {
    const { standardizePhoneNumber } = await import("../customer-utils");
    expect(() => standardizePhoneNumber("")).toThrow(
      "Invalid phone number format",
    );
  });
});

describe("phoneNumberSchema", () => {
  it("should accept a valid 11-digit phone number", async () => {
    const { phoneNumberSchema } = await import("../customer-utils");
    const result = phoneNumberSchema.parse("01712345678");
    expect(result).toBe("01712345678");
  });

  it("should accept a number with +880 prefix and standardize it", async () => {
    const { phoneNumberSchema } = await import("../customer-utils");
    const result = phoneNumberSchema.parse("+8801712345678");
    expect(result).toBe("01712345678");
  });

  it("should reject a string shorter than 11 characters", async () => {
    const { phoneNumberSchema } = await import("../customer-utils");
    expect(() => phoneNumberSchema.parse("0171234")).toThrow();
  });

  it("should reject a string longer than 14 characters", async () => {
    const { phoneNumberSchema } = await import("../customer-utils");
    expect(() => phoneNumberSchema.parse("012345678901234")).toThrow();
  });
});

// ─────────────────────────────────────────
// calculateCustomerStats()
// ─────────────────────────────────────────
describe("calculateCustomerStats()", () => {
  it("should return zero stats for empty orders array", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const stats = calculateCustomerStats([]);
    expect(stats.totalOrders).toBe(0);
    expect(stats.totalSpent).toBe(0);
    expect(stats.lastOrderAt).toBeNull();
  });

  it("should correctly sum total orders and total spent", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const orders = [
      { totalAmount: 100, createdAt: new Date("2024-01-01") },
      { totalAmount: 200, createdAt: new Date("2024-02-01") },
      { totalAmount: 50, createdAt: new Date("2024-03-01") },
    ];
    const stats = calculateCustomerStats(orders);
    expect(stats.totalOrders).toBe(3);
    expect(stats.totalSpent).toBe(350);
  });

  it("should return the latest order date", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const orders = [
      { totalAmount: 100, createdAt: new Date("2024-01-15") },
      { totalAmount: 200, createdAt: new Date("2024-06-20") },
      { totalAmount: 50, createdAt: new Date("2024-03-10") },
    ];
    const stats = calculateCustomerStats(orders);
    expect(stats.lastOrderAt).toBeInstanceOf(Date);
    expect(stats.lastOrderAt!.getTime()).toBe(
      new Date("2024-06-20").getTime(),
    );
  });

  it("should handle numeric timestamps for createdAt", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const orders = [
      { totalAmount: 100, createdAt: 1700000000000 },
      { totalAmount: 200, createdAt: 1710000000000 },
    ];
    const stats = calculateCustomerStats(orders);
    expect(stats.totalOrders).toBe(2);
    expect(stats.totalSpent).toBe(300);
    expect(stats.lastOrderAt!.getTime()).toBe(1710000000000);
  });

  it("should handle a single order", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const orders = [
      { totalAmount: 999, createdAt: new Date("2025-01-01") },
    ];
    const stats = calculateCustomerStats(orders);
    expect(stats.totalOrders).toBe(1);
    expect(stats.totalSpent).toBe(999);
    expect(stats.lastOrderAt!.getTime()).toBe(
      new Date("2025-01-01").getTime(),
    );
  });

  it("should handle orders with zero amounts", async () => {
    const { calculateCustomerStats } = await import("../customer-utils");
    const orders = [
      { totalAmount: 0, createdAt: new Date("2024-01-01") },
      { totalAmount: 0, createdAt: new Date("2024-02-01") },
    ];
    const stats = calculateCustomerStats(orders);
    expect(stats.totalOrders).toBe(2);
    expect(stats.totalSpent).toBe(0);
  });
});

// ─────────────────────────────────────────
// JSON repair utilities
// ─────────────────────────────────────────
describe("extractAndParseJSON()", () => {
  it("should parse plain JSON", async () => {
    const { extractAndParseJSON } = await import("../json-repair");
    const result = extractAndParseJSON('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  it("should extract JSON from markdown code blocks", async () => {
    const { extractAndParseJSON } = await import("../json-repair");
    const input = '```json\n{"key": "value"}\n```';
    const result = extractAndParseJSON(input);
    expect(result).toEqual({ key: "value" });
  });

  it("should extract JSON object from surrounding text", async () => {
    const { extractAndParseJSON } = await import("../json-repair");
    const input = 'Here is the JSON: {"key": "value"} that was generated.';
    const result = extractAndParseJSON(input);
    expect(result).toEqual({ key: "value" });
  });

  it("should throw for completely invalid input", async () => {
    const { extractAndParseJSON } = await import("../json-repair");
    expect(() => extractAndParseJSON("not json at all")).toThrow();
  });
});

describe("repairJSON()", () => {
  it("should remove trailing commas", async () => {
    const { repairJSON } = await import("../json-repair");
    const input = '{"a": 1, "b": 2,}';
    const repaired = repairJSON(input);
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: 2 });
  });

  it("should remove markdown code block markers", async () => {
    const { repairJSON } = await import("../json-repair");
    const input = '```json\n{"key": "value"}\n```';
    const repaired = repairJSON(input);
    expect(JSON.parse(repaired)).toEqual({ key: "value" });
  });

  it("should balance missing closing braces", async () => {
    const { repairJSON } = await import("../json-repair");
    const input = '{"a": {"b": 1}';
    const repaired = repairJSON(input);
    expect(repaired.endsWith("}")).toBe(true);
    expect(JSON.parse(repaired)).toEqual({ a: { b: 1 } });
  });

  it("should balance missing closing brackets", async () => {
    const { repairJSON } = await import("../json-repair");
    const input = '{"a": [1, 2, 3}';
    const repaired = repairJSON(input);
    expect(repaired).toContain("]");
  });

  it("should pass through valid JSON unchanged (structurally)", async () => {
    const { repairJSON } = await import("../json-repair");
    const input = '{"a": 1, "b": 2}';
    const repaired = repairJSON(input);
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: 2 });
  });
});

describe("parseJSONSafely()", () => {
  it("should succeed for valid JSON", async () => {
    const { parseJSONSafely } = await import("../json-repair");
    const result = parseJSONSafely('{"key": "value"}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ key: "value" });
  });

  it("should succeed for JSON in markdown code blocks", async () => {
    const { parseJSONSafely } = await import("../json-repair");
    const result = parseJSONSafely('```json\n{"key": "value"}\n```');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ key: "value" });
  });

  it("should succeed for JSON with trailing commas", async () => {
    const { parseJSONSafely } = await import("../json-repair");
    const result = parseJSONSafely('{"a": 1, "b": 2,}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ a: 1, b: 2 });
  });

  it("should return failure for completely unparseable input", async () => {
    const { parseJSONSafely } = await import("../json-repair");
    const result = parseJSONSafely("this is not json and has no braces");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("validateWidgetJSON()", () => {
  it("should accept valid widget JSON with html field", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({
      html: "<div>Hello</div>",
      css: ".hello { color: red; }",
    });
    expect(result.valid).toBe(true);
  });

  it("should accept valid widget JSON with htmljs field", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({
      htmljs: "<p>Content</p>",
    });
    expect(result.valid).toBe(true);
  });

  it("should reject null input", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not an object");
  });

  it("should reject non-object input", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON("string");
    expect(result.valid).toBe(false);
  });

  it("should reject missing html/htmljs field", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({ css: ".test {}" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("html");
  });

  it("should reject empty html content", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({ html: "   " });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });

  it("should reject html without valid HTML tags", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({ html: "just plain text" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("valid HTML tags");
  });

  it("should reject invalid css field type", async () => {
    const { validateWidgetJSON } = await import("../json-repair");
    const result = validateWidgetJSON({
      html: "<div>Test</div>",
      css: 123,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("css");
  });
});

// ─────────────────────────────────────────
// error-utils
// ─────────────────────────────────────────
describe("safeErrorResponse()", () => {
  it("should return a Response with the given status code", async () => {
    const { safeErrorResponse } = await import("../error-utils");
    const response = safeErrorResponse(new Error("test"), 404);
    expect(response.status).toBe(404);
  });

  it("should default to status 500", async () => {
    const { safeErrorResponse } = await import("../error-utils");
    const response = safeErrorResponse(new Error("test"));
    expect(response.status).toBe(500);
  });

  it("should return JSON content type", async () => {
    const { safeErrorResponse } = await import("../error-utils");
    const response = safeErrorResponse(new Error("test"));
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("should return no-store cache control", async () => {
    const { safeErrorResponse } = await import("../error-utils");
    const response = safeErrorResponse(new Error("test"));
    expect(response.headers.get("Cache-Control")).toBe(
      "no-store, max-age=0",
    );
  });

  it("should include a timestamp in the body", async () => {
    const { safeErrorResponse } = await import("../error-utils");
    const response = safeErrorResponse(new Error("test"));
    const body = await response.json();
    expect(body.timestamp).toBeDefined();
    expect(body.status).toBe("error");
  });

  it("should include error message in development mode", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      // Re-import to pick up env change
      const { safeErrorResponse } = await import("../error-utils");
      const response = safeErrorResponse(new Error("my custom error"));
      const body = await response.json();
      expect(body.message).toBe("my custom error");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("should use standard HTTP messages in production mode", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { safeErrorResponse } = await import("../error-utils");
      const response = safeErrorResponse(new Error("secret info"), 404);
      const body = await response.json();
      expect(body.message).toBe("Not Found");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});

describe("zodErrorResponse()", () => {
  it("should return a 400 response", async () => {
    const { zodErrorResponse } = await import("../error-utils");
    const response = zodErrorResponse({ errors: [{ message: "bad" }] });
    expect(response.status).toBe(400);
  });

  it("should include validation error details in the body", async () => {
    const { zodErrorResponse } = await import("../error-utils");
    const errors = [{ path: "name", message: "Required" }];
    const response = zodErrorResponse({ errors });
    const body = await response.json();
    expect(body.status).toBe("error");
    expect(body.message).toBe("Validation failed");
    expect(body.details).toEqual(errors);
  });
});

describe("honoSafeError()", () => {
  it("should call c.json with error shape and status", async () => {
    const { honoSafeError } = await import("../error-utils");
    let capturedBody: any;
    let capturedStatus: any;
    const mockContext = {
      json: (body: unknown, status?: number) => {
        capturedBody = body;
        capturedStatus = status;
        return { body, status };
      },
    };

    honoSafeError(mockContext, new Error("boom"), 503);
    expect(capturedStatus).toBe(503);
    expect(capturedBody.success).toBe(false);
    expect(capturedBody.timestamp).toBeDefined();
  });
});
