import { describe, expect, it } from "vitest";

import {
  parseScaliusCommandProgram,
  SCALIUS_COMMAND_HELP,
  SCALIUS_COMMAND_LIMITS,
  SCALIUS_COMMAND_NAMES,
  SCALIUS_COMMAND_TOOL_DESCRIPTION,
  type ScaliusCommandParseErrorCode,
} from "./assistant-command";

function errorCode(program: unknown): ScaliusCommandParseErrorCode | null {
  const result = parseScaliusCommandProgram(program);
  return result.ok ? null : result.error.code;
}

describe("Scalius authoritative command grammar", () => {
  it("parses the complete compact grammar into typed commands", () => {
    expect(parseScaliusCommandProgram("help")).toEqual({
      ok: true,
      command: { name: "help" },
    });
    expect(parseScaliusCommandProgram("help inventory adjustment policy")).toEqual({
      ok: true,
      command: { name: "help", query: "inventory adjustment policy" },
    });
    expect(parseScaliusCommandProgram("find   low stock   products")).toEqual({
      ok: true,
      command: { name: "find", terms: "low stock products" },
    });
    expect(parseScaliusCommandProgram("show admin.api.get.products.by-id")).toEqual({
      ok: true,
      command: { name: "show", capabilityId: "admin.api.get.products.by-id" },
    });
    expect(parseScaliusCommandProgram(
      'call catalog.search -- {"query":"red shoes","filters":{"sizes":["40","41"]},"limit":10}',
    )).toEqual({
      ok: true,
      command: {
        name: "call",
        capabilityId: "catalog.search",
        arguments: {
          query: "red shoes",
          filters: { sizes: ["40", "41"] },
          limit: 10,
        },
      },
    });
    expect(parseScaliusCommandProgram(
      'prepare admin.product.update -- {"productId":"prod_1","patch":{"title":"Trail shoe"}}',
    )).toEqual({
      ok: true,
      command: {
        name: "prepare",
        capabilityId: "admin.product.update",
        arguments: {
          productId: "prod_1",
          patch: { title: "Trail shoe" },
        },
      },
    });
    expect(parseScaliusCommandProgram("status action_01JZ9YW6C7Q8X1A2B3C4D5E6F7")).toEqual({
      ok: true,
      command: { name: "status", targetId: "action_01JZ9YW6C7Q8X1A2B3C4D5E6F7" },
    });
    expect(parseScaliusCommandProgram("cancel workflow_01JZ9YW6C7Q8X1A2B3C4D5E6F7")).toEqual({
      ok: true,
      command: { name: "cancel", workflowId: "workflow_01JZ9YW6C7Q8X1A2B3C4D5E6F7" },
    });
  });

  it("keeps capability classification and authority out of the parser", () => {
    const result = parseScaliusCommandProgram(
      'call admin.order.refund -- {"orderId":"ord_1","amount":10}',
    );
    expect(result).toMatchObject({
      ok: true,
      command: { name: "call", capabilityId: "admin.order.refund" },
    });
    if (!result.ok) throw new Error("Expected parsed command");
    expect(result.command).not.toHaveProperty("risk");
    expect(result.command).not.toHaveProperty("permission");
    expect(result.command).not.toHaveProperty("requestId");
    expect(result.command).not.toHaveProperty("idempotencyKey");
  });

  it("exposes no model command for approval, execution, transports, code, or SQL", () => {
    expect(SCALIUS_COMMAND_NAMES).toEqual([
      "help",
      "find",
      "show",
      "call",
      "prepare",
      "status",
      "cancel",
    ]);
    for (const program of [
      "confirm action_1",
      "approve action_1",
      "execute action_1",
      "GET /api/v1/admin/products",
      "post https://evil.example",
      "fetch https://evil.example",
      "shell rm -rf /",
      "bash -lc whoami",
      "js alert(1)",
      "sql SELECT * FROM users",
    ]) {
      expect(errorCode(program), program).toBe("FORBIDDEN_COMMAND");
    }
    expect(errorCode("call https://evil.example -- {}"))
      .toBe("INVALID_CAPABILITY_ID");
  });

  it("rejects multiline, control characters, and command chaining but permits punctuation in JSON strings", () => {
    expect(errorCode("find products\nshow catalog.search")).toBe("MULTILINE");
    expect(errorCode("find products\rshow catalog.search")).toBe("MULTILINE");
    expect(errorCode("find\tproducts")).toBe("CONTROL_CHARACTER");
    expect(errorCode("find products; show catalog.search")).toBe("CHAINING_NOT_ALLOWED");
    expect(errorCode("find products && show catalog.search")).toBe("CHAINING_NOT_ALLOWED");
    expect(errorCode("find products | execute action_1")).toBe("CHAINING_NOT_ALLOWED");
    expect(errorCode("find `whoami`")).toBe("CHAINING_NOT_ALLOWED");
    expect(errorCode("find $(whoami)")).toBe("CHAINING_NOT_ALLOWED");
    expect(parseScaliusCommandProgram(
      'prepare admin.product.update -- {"copy":"Soft; light & comfortable | durable"}',
    ).ok).toBe(true);
  });

  it("rejects malformed, missing, ambiguous, and oversized command arguments", () => {
    expect(errorCode(42)).toBe("INVALID_TYPE");
    expect(errorCode("   ")).toBe("EMPTY_PROGRAM");
    expect(errorCode("unknown whatever")).toBe("UNKNOWN_COMMAND");
    expect(errorCode("find")).toBe("ARGUMENTS_REQUIRED");
    expect(errorCode("show")).toBe("ARGUMENTS_REQUIRED");
    expect(errorCode("show catalog.search extra")).toBe("UNEXPECTED_ARGUMENTS");
    expect(errorCode("show Catalog.Search")).toBe("INVALID_CAPABILITY_ID");
    expect(errorCode("status action/1")).toBe("INVALID_REFERENCE_ID");
    expect(errorCode("cancel workflow_1 extra")).toBe("UNEXPECTED_ARGUMENTS");
    expect(errorCode("call catalog.search {}"))
      .toBe("JSON_DELIMITER_REQUIRED");
    expect(errorCode("call catalog.search --"))
      .toBe("JSON_DELIMITER_REQUIRED");
    expect(errorCode("call catalog.search -- ")).toBe("JSON_DELIMITER_REQUIRED");
    expect(errorCode("call catalog.search -- nope")).toBe("INVALID_JSON");
    expect(errorCode("call catalog.search -- []")).toBe("JSON_OBJECT_REQUIRED");
    expect(errorCode("call catalog.search -- null")).toBe("JSON_OBJECT_REQUIRED");
    expect(errorCode(`find ${"x".repeat(SCALIUS_COMMAND_LIMITS.termsChars + 1)}`))
      .toBe("TERMS_TOO_LONG");
    expect(errorCode(`find ${Array.from({ length: SCALIUS_COMMAND_LIMITS.termsCount + 1 }, () => "x").join(" ")}`))
      .toBe("TOO_MANY_TERMS");
    expect(errorCode(`show a${"b".repeat(SCALIUS_COMMAND_LIMITS.capabilityIdChars)}`))
      .toBe("INVALID_CAPABILITY_ID");
    expect(errorCode(`status a${"b".repeat(SCALIUS_COMMAND_LIMITS.referenceIdChars)}`))
      .toBe("INVALID_REFERENCE_ID");
    expect(errorCode("x".repeat(SCALIUS_COMMAND_LIMITS.programChars + 1)))
      .toBe("PROGRAM_TOO_LONG");
  });

  it("bounds JSON size, depth, keys, arrays, strings, values, and numbers", () => {
    expect(errorCode(
      `call catalog.search -- {"value":"${"x".repeat(SCALIUS_COMMAND_LIMITS.jsonChars)}"}`,
    )).toBe("JSON_TOO_LONG");
    expect(errorCode(
      `call catalog.search -- {"${"k".repeat(SCALIUS_COMMAND_LIMITS.jsonKeyChars + 1)}":1}`,
    )).toBe("JSON_KEY_TOO_LONG");
    expect(errorCode(`call catalog.search -- ${JSON.stringify(Object.fromEntries(
      Array.from({ length: SCALIUS_COMMAND_LIMITS.jsonKeys + 1 }, (_, index) => [`k${index}`, index]),
    ))}`)).toBe("JSON_TOO_MANY_KEYS");
    expect(errorCode(`call catalog.search -- ${JSON.stringify({
      values: Array.from({ length: SCALIUS_COMMAND_LIMITS.jsonArrayItems + 1 }, () => 1),
    })}`)).toBe("JSON_ARRAY_TOO_LONG");
    expect(errorCode(`call catalog.search -- ${JSON.stringify({
      value: "x".repeat(SCALIUS_COMMAND_LIMITS.jsonStringChars + 1),
    })}`)).toBe("JSON_STRING_TOO_LONG");

    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < SCALIUS_COMMAND_LIMITS.jsonDepth; index += 1) {
      nested = { nested };
    }
    expect(errorCode(`call catalog.search -- ${JSON.stringify(nested)}`))
      .toBe("JSON_DEPTH_EXCEEDED");

    const values = Array.from(
      { length: SCALIUS_COMMAND_LIMITS.jsonValues },
      (_, index) => index,
    );
    const chunks = Array.from({ length: 6 }, (_, index) =>
      values.slice(index * 43, (index + 1) * 43));
    expect(errorCode(`call catalog.search -- ${JSON.stringify({ chunks })}`))
      .toBe("JSON_TOO_MANY_VALUES");
    expect(errorCode("call catalog.search -- {\"value\":1e400}"))
      .toBe("JSON_NUMBER_UNSAFE");
    expect(errorCode("call catalog.search -- {\"value\":9007199254740992}"))
      .toBe("JSON_NUMBER_UNSAFE");
  });

  it.each([
    '{"password":"never"}',
    '{"apiKey":"never"}',
    '{"client_secret":"never"}',
    '{"credentialId":"credential_1"}',
    '{"otpCode":"123456"}',
    '{"auth":{"verification":{"code":"123456"}}}',
    '{"receiptProof":"proof"}',
    '{"receipt":{"proof":"proof"}}',
    '{"receiptproofhash":"proof"}',
    '{"paymentMethodToken":"tok_1"}',
    '{"paymentmethodtoken":"tok_1"}',
    '{"passwordhash":"never"}',
    '{"encryptedcredentialid":"credential_1"}',
    '{"signingKey":"never"}',
  ])("rejects secret-shaped JSON key paths without reflecting them: %s", (json) => {
    const result = parseScaliusCommandProgram(`prepare admin.settings.update -- ${json}`);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "SENSITIVE_KEY",
        message: "Secrets and credential-shaped inputs are not allowed.",
      },
    });
  });

  it.each([
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted":true}}}',
    '{"nested":{"prototype":{"polluted":true}}}',
  ])("rejects prototype-pollution keys at every depth: %s", (json) => {
    expect(errorCode(`call catalog.search -- ${json}`)).toBe("PROTOTYPE_KEY");
  });

  it("rejects control characters that appear only after JSON decoding", () => {
    expect(errorCode('call catalog.search -- {"query":"red\\nshoe"}'))
      .toBe("JSON_CONTROL_CHARACTER");
    expect(errorCode('call catalog.search -- {"bad\\tkey":"value"}'))
      .toBe("JSON_CONTROL_CHARACTER");
  });

  it("returns deterministic bounded errors and keeps tool context compact", () => {
    const first = parseScaliusCommandProgram("call catalog.search -- {");
    const second = parseScaliusCommandProgram("call catalog.search -- {");
    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: false,
      error: { code: "INVALID_JSON", message: "Arguments must be valid JSON." },
    });

    expect(SCALIUS_COMMAND_TOOL_DESCRIPTION.length).toBeLessThan(700);
    expect(SCALIUS_COMMAND_HELP.length).toBeLessThan(800);
    expect(SCALIUS_COMMAND_TOOL_DESCRIPTION).not.toContain("admin.api.get.products");
    expect(SCALIUS_COMMAND_HELP).not.toContain("OpenAPI");
    expect(SCALIUS_COMMAND_HELP.split("\n")).toHaveLength(SCALIUS_COMMAND_NAMES.length);
  });
});
