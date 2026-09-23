import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import systemApp from "../runtime/system-app";

function harness(options: { rateLimited?: boolean } = {}) {
  const { sqlite, binding } = createSqliteD1Database();
  const env = {
    DB: binding,
    AGENT_TOKEN_PEPPER: "agent-auth-route-test-pepper-longer-than-32-chars",
    CREDENTIAL_ENCRYPTION_KEY: btoa("k".repeat(32)),
    BETTER_AUTH_URL: "https://admin.scalius.test/some/path",
    RL_STANDARD: { limit: async () => ({ success: !options.rateLimited }) },
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
  } as unknown as Env;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => systemApp.request(
    `https://api.scalius.test/api/v1/agent-auth${path}`,
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) },
    env,
  );
  return { sqlite, post };
}

describe("agent-auth device pairing", () => {
  it("starts a private audience-bound pairing without putting codes in the continuation URL or database", async () => {
    const { sqlite, post } = harness();

    const response = await post("/device/start", { clientName: "CLI", resource: "storefront" });
    const body = await response.json() as { deviceCode: string; userCode: string; verificationUri: string; resource: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body.verificationUri).toBe("https://admin.scalius.test/connect");
    expect(body.resource).toBe("storefront");
    const stored = JSON.stringify(sqlite.prepare("SELECT * FROM agent_device_authorizations").all());
    expect(stored).toContain('"requested_resource":"storefront"');
    expect(stored).not.toContain(body.deviceCode);
    expect(stored).not.toContain(body.userCode);
  });

  it.each(["/device/start", "/device/token", "/device/ack"])("rate limits unauthenticated %s", async (path) => {
    const { post } = harness({ rateLimited: true });

    const response = await post(path, path === "/device/start" ? { clientName: "CLI" } : { deviceCode: "a".repeat(43) });

    expect(response.status).toBe(429);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("makes acknowledgement retry-safe and destroys the delivery envelope", async () => {
    const { sqlite, post } = harness();
    const { deviceCode } = await (await post("/device/start", { clientName: "CLI" })).json() as { deviceCode: string };
    const t = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO user (id, name, email) VALUES ('owner-1', 'Owner', 'owner@example.test');
      INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, preset, risk_ceiling, status, expires_at, created_at, updated_at)
      VALUES ('agr_0123456789abcdefghij', 'cli', 'owner-1', 'dashboard', 'CLI', 'full', 'read', 'active', ${t + 3600}, ${t}, ${t});
      INSERT INTO agent_credentials (id, grant_id, kind, token_hash, token_hint, expires_at, created_at, updated_at)
      VALUES ('agc_0123456789abcdefghij', 'agr_0123456789abcdefghij', 'cli', '${"a".repeat(64)}', 'sc_cli_...hint', ${t + 3600}, ${t}, ${t});
      UPDATE agent_device_authorizations SET status = 'approved', decided_at = ${t}, approved_by_user_id = 'owner-1',
        grant_id = 'agr_0123456789abcdefghij', credential_id = 'agc_0123456789abcdefghij', encrypted_delivery_envelope = 'sealed';
    `);

    const first = await post("/device/ack", { deviceCode });
    const retry = await post("/device/ack", { deviceCode });

    expect([first.status, retry.status]).toEqual([200, 200]);
    await expect(retry.json()).resolves.toEqual({ status: "acknowledged" });
    expect(sqlite.prepare("SELECT status, encrypted_delivery_envelope FROM agent_device_authorizations").get())
      .toEqual({ status: "consumed", encrypted_delivery_envelope: null });
  });

  it("rejects mixed cookie and bearer credentials during self-revoke", async () => {
    const { post } = harness();

    const response = await post("/revoke", {}, {
      Cookie: "better-auth.session_token=session",
      Authorization: `Bearer sc_pat_agc_0123456789abcdefghij_${"a".repeat(43)}`,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: "Cookie and agent credentials cannot be combined" },
    });
  });
});
