import { describe, expect, it } from "vitest";
import { authorizeAgentRequest } from "./auth";
import { createThreadInstanceId, verifyThreadInstanceId, type ThreadIdentity } from "./thread-identity";

const SIGNING_KEY = "storefront-canary-test-signing-key-32-bytes-minimum";
const AUTH_TOKEN = "storefront-canary-test-auth-token-at-least-32-bytes";
const IDENTITY: ThreadIdentity = {
  tenantId: "store_a",
  principalId: "customer_42",
  threadId: "thread_7",
};

describe("storefront Flue thread isolation", () => {
  it("creates stable IDs and isolates every identity axis", async () => {
    const original = await createThreadInstanceId("storefront", IDENTITY, SIGNING_KEY);
    expect(await createThreadInstanceId("storefront", IDENTITY, SIGNING_KEY)).toBe(original);
    await expect(
      createThreadInstanceId("storefront", { ...IDENTITY, tenantId: "store_b" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(
      createThreadInstanceId("storefront", { ...IDENTITY, principalId: "customer_43" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(
      createThreadInstanceId("storefront", { ...IDENTITY, threadId: "thread_8" }, SIGNING_KEY),
    ).resolves.not.toBe(original);
    await expect(createThreadInstanceId("admin", IDENTITY, SIGNING_KEY)).resolves.not.toBe(original);
  });

  it("rejects tampering, wrong surfaces, and wrong signing keys", async () => {
    const instanceId = await createThreadInstanceId("storefront", IDENTITY, SIGNING_KEY);
    expect(await verifyThreadInstanceId(instanceId, "storefront", IDENTITY, SIGNING_KEY)).toBe(true);
    expect(await verifyThreadInstanceId(`${instanceId}x`, "storefront", IDENTITY, SIGNING_KEY)).toBe(false);
    expect(await verifyThreadInstanceId(instanceId, "admin", IDENTITY, SIGNING_KEY)).toBe(false);
    expect(await verifyThreadInstanceId(instanceId, "storefront", IDENTITY, `${SIGNING_KEY}-other`)).toBe(false);
    expect(instanceId).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/u);
    expect(instanceId).not.toContain(IDENTITY.tenantId);
    expect(instanceId).not.toContain(IDENTITY.principalId);
    expect(instanceId).not.toContain(IDENTITY.threadId);
  });

  it("authorizes only the exact signed thread and bound caller headers", async () => {
    const instanceId = await createThreadInstanceId("storefront", IDENTITY, SIGNING_KEY);
    const headers = {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "X-Scalius-Tenant-Id": IDENTITY.tenantId,
      "X-Scalius-Principal-Id": IDENTITY.principalId,
      "X-Scalius-Thread-Id": IDENTITY.threadId,
    };
    const request = new Request(`https://agent.test/agents/shopping-assistant/${instanceId}`, { headers });
    await expect(
      authorizeAgentRequest(
        request,
        { CANARY_AUTH_TOKEN: AUTH_TOKEN, THREAD_ID_SIGNING_KEY: SIGNING_KEY, COMPUTER_TICKET_SIGNING_KEY: SIGNING_KEY },
        "shopping-assistant",
        "storefront",
      ),
    ).resolves.toEqual({ authorized: true, identity: IDENTITY });

    const wrongPrincipal = new Request(request, {
      headers: { ...headers, "X-Scalius-Principal-Id": "customer_43" },
    });
    await expect(
      authorizeAgentRequest(
        wrongPrincipal,
        { CANARY_AUTH_TOKEN: AUTH_TOKEN, THREAD_ID_SIGNING_KEY: SIGNING_KEY, COMPUTER_TICKET_SIGNING_KEY: SIGNING_KEY },
        "shopping-assistant",
        "storefront",
      ),
    ).resolves.toEqual({
      authorized: false,
      reason: "thread_identity_invalid",
    });
  });
});
