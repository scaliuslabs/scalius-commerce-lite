import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { login, revoke } from "../src/auth.js";
import { ConfigStore } from "../src/config.js";
import { createTestRuntime, validToken } from "./helpers.js";

describe("finalized agent-auth route contract", () => {
  it("matches start, pending, approved, idempotent ack, and revoke without live credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-auth-contract-"));
    const token = validToken("cli");
    const credentialId = `agc_${"A".repeat(20)}`;
    const requests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
    let pollCount = 0;
    let acknowledged = false;
    let revoked = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ path: url.pathname, body, authorization: new Headers(init?.headers).get("Authorization") });
      switch (url.pathname) {
        case "/api/v1/agent-auth/device/start":
          expect(body).toEqual({ clientName: "Scalius CLI", profileName: "contract" });
          return Response.json({
            deviceCode: "D".repeat(43),
            userCode: "ABCD2345",
            verificationUri: "https://dashboard.example.com/connect",
            intervalSeconds: 5,
            expiresInSeconds: 600,
          });
        case "/api/v1/agent-auth/device/token":
          expect(body).toEqual({ deviceCode: "D".repeat(43) });
          pollCount += 1;
          return pollCount === 1
            ? Response.json({ status: "pending", intervalSeconds: 5 }, { status: 202 })
            : Response.json({
              status: "approved",
              token,
              credentialId,
              expiresAt: "2026-08-14T00:00:00.000Z",
            });
        case "/api/v1/agent-auth/device/ack":
          expect(body).toEqual({ deviceCode: "D".repeat(43) });
          acknowledged = true;
          return Response.json({ status: "acknowledged" });
        case "/api/v1/agent-auth/revoke":
          expect(body).toEqual({});
          expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
          revoked = true;
          return Response.json({ status: "revoked" });
        default:
          return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
      }
    });
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });

    const result = await login(runtime, {
      server: "https://api.example.com",
      profileName: "contract",
      openBrowser: false,
    });
    expect(result).toMatchObject({ status: "authenticated", profile: "contract", credentialId });
    expect(acknowledged).toBe(true);
    const store = new ConfigStore(runtime);
    const stored = await store.loadCredentials();
    expect(stored.credentials.contract).toMatchObject({ token, credentialId });
    expect(stored.credentials.contract?.pendingAcknowledgement).toBeUndefined();
    expect(await readFile(store.configPath, "utf8")).not.toContain(token);
    expect(runtime.stdoutText()).not.toContain(token);
    expect(runtime.stderrText()).not.toContain(token);

    const revokeResult = await revoke(runtime, "contract");
    expect(revokeResult.status).toBe("revoked");
    expect(revoked).toBe(true);
    expect((await store.loadCredentials()).credentials.contract).toBeUndefined();
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/v1/agent-auth/device/start",
      "/api/v1/agent-auth/device/token",
      "/api/v1/agent-auth/device/token",
      "/api/v1/agent-auth/device/ack",
      "/api/v1/agent-auth/revoke",
    ]);
  });

  it("recovers safely when the idempotent ack response was lost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-ack-contract-"));
    const token = validToken("cli");
    const storeRuntime = createTestRuntime({ directory });
    const store = new ConfigStore(storeRuntime);
    await store.putProfile("contract", "https://api.example.com");
    await store.putCredential("contract", {
      token,
      credentialId: `agc_${"A".repeat(20)}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      pendingAcknowledgement: { deviceCode: "D".repeat(43) },
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/agent-auth/device/ack");
      return Response.json({ status: "acknowledged" });
    });
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });
    const result = await login(runtime, {
      server: "https://api.example.com",
      profileName: "contract",
      openBrowser: false,
    });
    expect(result).toMatchObject({ status: "authenticated", recoveredAcknowledgement: true });
    expect((await new ConfigStore(runtime).loadCredentials()).credentials.contract?.pendingAcknowledgement).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
