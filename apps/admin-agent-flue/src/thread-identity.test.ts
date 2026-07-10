import { describe, expect, it } from "vitest";
import { authorizeAgentRequest } from "./auth";
import { createThreadInstanceId, verifyThreadInstanceId, type ThreadIdentity } from "./thread-identity";

const SIGNING_KEY = "admin-canary-test-signing-key-32-bytes-minimum";
const AUTH_TOKEN = "admin-canary-test-auth-token-at-least-32-bytes";
const IDENTITY: ThreadIdentity = {
  tenantId: "merchant_a",
  principalId: "admin_42",
  threadId: "thread_7",
};

describe("admin Flue thread isolation", () => {
  it("creates stable IDs and isolates every identity axis", async () => {
    const original = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);
    expect(await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY)).toBe(original);
    await expect(
      createThreadInstanceId("admin", { ...IDENTITY, tenantId: "merchant_b" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(
      createThreadInstanceId("admin", { ...IDENTITY, principalId: "admin_43" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(
      createThreadInstanceId("admin", { ...IDENTITY, threadId: "thread_8" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(createThreadInstanceId("storefront", IDENTITY, SIGNING_KEY)).resolves.not.toBe(original);
  });

  it("rejects tampering, wrong surfaces, and wrong signing keys", async () => {
    const instanceId = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);
    expect(await verifyThreadInstanceId(instanceId, "admin", IDENTITY, SIGNING_KEY)).toBe(true);
    expect(await verifyThreadInstanceId(`${instanceId}x`, "admin", IDENTITY, SIGNING_KEY)).toBe(false);
    expect(await verifyThreadInstanceId(instanceId, "storefront", IDENTITY, SIGNING_KEY)).toBe(false);
    expect(await verifyThreadInstanceId(instanceId, "admin", IDENTITY, `${SIGNING_KEY}-other`)).toBe(false);
    expect(instanceId).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(instanceId).not.toContain(IDENTITY.tenantId);
    expect(instanceId).not.toContain(IDENTITY.principalId);
    expect(instanceId).not.toContain(IDENTITY.threadId);
  });

  it("authorizes only the exact signed thread and bound caller headers", async () => {
    const instanceId = await createThreadInstanceId("admin", IDENTITY, SIGNING_KEY);
    const headers = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Scalius-Tenant-Id": IDENTITY.tenantId,
      "X-Scalius-Principal-Id": IDENTITY.principalId,
      "X-Scalius-Thread-Id": IDENTITY.threadId,
    };
    const request = new Request(`https://agent.test/agents/admin-copilot/${instanceId}`, { headers });
    await expect(
      authorizeAgentRequest(
        request,
        { CANARY_AUTH_TOKEN: AUTH_TOKEN, THREAD_ID_SIGNING_KEY: SIGNING_KEY },
        "admin-copilot",
        "admin",
      ),
    ).resolves.toEqual({ authorized: true, identity: IDENTITY });

    const wrongTenant = new Request(request, {
      headers: { ...headers, "X-Scalius-Tenant-Id": "merchant_b" },
    });
    await expect(
      authorizeAgentRequest(
        wrongTenant,
        { CANARY_AUTH_TOKEN: AUTH_TOKEN, THREAD_ID_SIGNING_KEY: SIGNING_KEY },
        "admin-copilot",
        "admin",
      ),
    ).resolves.toEqual({ authorized: false });
  });
});
