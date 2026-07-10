import { describe, expect, it } from "vitest";

import {
  createThreadInstanceId,
  isValidThreadIdentity,
  verifyThreadInstanceId,
} from "./assistant-thread-identity";

const SIGNING_KEY = "thread-identity-signing-key-32-bytes-minimum";
const IDENTITY = {
  tenantId: "tenant_fYqQ4j2d",
  principalId: "principal_oZ3k2m1p",
  threadId: "conv_abcdefghijklmnopqrstuv",
};

describe("assistant thread identity", () => {
  it("creates a deterministic opaque surface-bound instance ID", async () => {
    const first = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);
    const second = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);

    expect(first).toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain(IDENTITY.tenantId);
    expect(first).not.toContain(IDENTITY.principalId);
    expect(first).not.toContain(IDENTITY.threadId);
    await expect(verifyThreadInstanceId(
      first,
      "admin",
      IDENTITY,
      SIGNING_KEY,
    )).resolves.toBe(true);
  });

  it("rejects cross-surface, cross-tenant, cross-principal and cross-thread reuse", async () => {
    const instanceId = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);

    for (const [surface, identity] of [
      ["storefront", IDENTITY],
      ["admin", { ...IDENTITY, tenantId: "tenant_other" }],
      ["admin", { ...IDENTITY, principalId: "principal_other" }],
      ["admin", { ...IDENTITY, threadId: "conv_otherabcdefghijklmnop" }],
    ] as const) {
      await expect(verifyThreadInstanceId(
        instanceId,
        surface,
        identity,
        SIGNING_KEY,
      )).resolves.toBe(false);
    }
  });

  it("fails closed for malformed identities, IDs and undersized keys", async () => {
    expect(isValidThreadIdentity({ ...IDENTITY, tenantId: "bad tenant" })).toBe(false);
    await expect(createThreadInstanceId(
      "admin",
      { ...IDENTITY, tenantId: "bad tenant" },
      SIGNING_KEY,
    )).rejects.toThrow("Invalid thread identity");
    await expect(createThreadInstanceId("admin", IDENTITY, "too-short"))
      .rejects.toThrow("at least 32 bytes");
    await expect(verifyThreadInstanceId(
      "v1.not-a-real-signature",
      "admin",
      IDENTITY,
      SIGNING_KEY,
    )).resolves.toBe(false);
  });
});
