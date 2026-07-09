import { describe, expect, it } from "vitest";

import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";

import {
  ASSISTANT_APPROVAL_CREDENTIAL_PREFIX,
  ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX,
  ASSISTANT_SESSION_CREDENTIAL_PREFIX,
  canonicalizeAssistantJson,
  createAssistantApprovalCredential,
  createAssistantSessionCredential,
  decryptAssistantArguments,
  encryptAssistantArguments,
  hashAssistantApprovalCredential,
  hashAssistantArguments,
  hashAssistantRateLimitBucket,
  hashAssistantSessionCredential,
} from "./assistant-crypto";

describe("assistant authority crypto", () => {
  it("canonicalizes equivalent bounded JSON identically", async () => {
    const left = { z: [3, { b: true, a: "value" }], a: -0 };
    const right = { a: 0, z: [3, { a: "value", b: true }] };

    expect(canonicalizeAssistantJson(left)).toBe(
      '{"a":0,"z":[3,{"a":"value","b":true}]}',
    );
    await expect(hashAssistantArguments(left)).resolves.toBe(
      await hashAssistantArguments(right),
    );
  });

  it("rejects non-JSON, dangerous, cyclic, and oversized values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalizeAssistantJson({ value: undefined })).toThrow(ValidationError);
    expect(() => canonicalizeAssistantJson({ value: Number.NaN })).toThrow(ValidationError);
    expect(() => canonicalizeAssistantJson({ __proto__: { polluted: true } })).toThrow(
      ValidationError,
    );
    expect(() => canonicalizeAssistantJson(cyclic)).toThrow(ValidationError);
    expect(() => canonicalizeAssistantJson("abcd", { maxBytes: 3 })).toThrow(ValidationError);
  });

  it("uses explicit redactor-friendly opaque credential prefixes and stores only hashes", async () => {
    const sessionCredential = createAssistantSessionCredential();
    const approvalCredential = await createAssistantApprovalCredential(
      "assistant-approval-key-0123456789abcdef",
      {
        actionId: "aa_action_1",
        argumentsHash: "a".repeat(64),
        approvedBy: "admin_1",
        approvedAt: new Date("2026-07-10T00:00:00.000Z"),
        expiresAt: new Date("2026-07-10T00:10:00.000Z"),
      },
    );

    expect(sessionCredential).toMatch(/^session_asst_[A-Za-z0-9_-]{43}$/);
    expect(approvalCredential).toMatch(/^approval_asst_[A-Za-z0-9_-]{43}$/);
    expect(sessionCredential.startsWith(ASSISTANT_SESSION_CREDENTIAL_PREFIX)).toBe(true);
    expect(approvalCredential.startsWith(ASSISTANT_APPROVAL_CREDENTIAL_PREFIX)).toBe(true);
    expect(sessionCredential).not.toMatch(/^asc_/);
    expect(approvalCredential).not.toMatch(/^aac_/);

    const sessionHash = await hashAssistantSessionCredential(sessionCredential);
    const approvalHash = await hashAssistantApprovalCredential(approvalCredential);
    expect(sessionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(approvalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionHash).not.toContain(sessionCredential);
    expect(approvalHash).not.toContain(approvalCredential);

    await expect(hashAssistantSessionCredential("session_asst_a")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(hashAssistantSessionCredential(
      `session_asst_${"a".repeat(42)}`,
    )).rejects.toBeInstanceOf(ValidationError);
    await expect(hashAssistantSessionCredential(
      `session_asst_${"a".repeat(44)}`,
    )).rejects.toBeInstanceOf(ValidationError);
    await expect(hashAssistantApprovalCredential("approval_asst_a")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("encrypts canonical arguments with action/hash binding and no plaintext fallback", async () => {
    const encryptionKey = base64Key(7);
    const canonical = canonicalizeAssistantJson({ orderId: "order_1", amount: 125 });
    const argumentsHash = await hashAssistantArguments({ amount: 125, orderId: "order_1" });
    const binding = { actionId: "aa_action_1", argumentsHash };

    const encrypted = await encryptAssistantArguments(canonical, encryptionKey, binding);
    expect(encrypted.startsWith(ASSISTANT_ARGUMENTS_ENCRYPTION_PREFIX)).toBe(true);
    expect(encrypted).not.toContain("order_1");
    await expect(decryptAssistantArguments(encrypted, encryptionKey, binding)).resolves.toBe(
      canonical,
    );
    await expect(decryptAssistantArguments(encrypted, base64Key(8), binding)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(decryptAssistantArguments(encrypted, encryptionKey, {
      ...binding,
      actionId: "aa_action_2",
    })).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(encryptAssistantArguments(canonical, "", binding)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(decryptAssistantArguments(canonical, encryptionKey, binding)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it("HMACs rate-limit identities with scope separation", async () => {
    const first = await hashAssistantRateLimitBucket(
      "storefront.chat",
      "203.0.113.9",
      "assistant-rate-limit-key-0123456789abcdef",
    );
    const second = await hashAssistantRateLimitBucket(
      "storefront.cart",
      "203.0.113.9",
      "assistant-rate-limit-key-0123456789abcdef",
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("203.0.113.9");
    expect(second).not.toBe(first);
  });
});

function base64Key(seed: number): string {
  return btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (
    seed + index
  ) % 256)));
}
