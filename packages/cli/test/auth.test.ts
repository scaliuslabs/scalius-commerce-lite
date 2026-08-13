import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { login, revoke } from "../src/auth.js";
import { ConfigStore } from "../src/config.js";
import { createTestRuntime, validToken } from "./helpers.js";

describe("authentication", () => {
  it("pairs, stores before ack, acknowledges, and never writes the token to output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-cli-"));
    const token = validToken();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let poll = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/device/start")) return Response.json({
        deviceCode: "device-secret",
        userCode: "ABCD1234",
        verificationUri: "https://dashboard.example.com/connect",
        intervalSeconds: 1,
        expiresInSeconds: 60,
      });
      if (url.endsWith("/device/token")) {
        poll += 1;
        return poll === 1
          ? Response.json({ status: "pending", intervalSeconds: 1 }, { status: 202 })
          : Response.json({ status: "approved", token, credentialId: `agc_${"A".repeat(20)}` });
      }
      if (url.endsWith("/device/ack")) {
        const stored = await new ConfigStore(runtime).loadCredentials();
        expect(stored.credentials.default?.pendingAcknowledgement?.deviceCode).toBe("device-secret");
        return Response.json({ status: "acknowledged" });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    });
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });
    const result = await login(runtime, { server: "https://api.example.com", profileName: "default", openBrowser: true });
    expect(result.status).toBe("authenticated");
    expect(runtime.openedUrls).toEqual(["https://dashboard.example.com/connect"]);
    expect(runtime.stdoutText()).not.toContain(token);
    expect(runtime.stderrText()).not.toContain(token);
    const stored = await new ConfigStore(runtime).loadCredentials();
    expect(stored.credentials.default?.token).toBe(token);
    expect(stored.credentials.default?.pendingAcknowledgement).toBeUndefined();
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.example.com/api/v1/agent-auth/device/start",
      "https://api.example.com/api/v1/agent-auth/device/token",
      "https://api.example.com/api/v1/agent-auth/device/token",
      "https://api.example.com/api/v1/agent-auth/device/ack",
    ]);
  });

  it("uses each merchant API and dashboard origin without a Scalius demo-domain dependency", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-custom-domain-"));
    const token = validToken();
    const requestedUrls: string[] = [];
    let poll = 0;
    const runtime = createTestRuntime({
      directory,
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/device/start")) return Response.json({
          deviceCode: "merchant-device-secret",
          userCode: "SHOP1234",
          verificationUri: "https://control.merchant.example/connect",
          intervalSeconds: 1,
          expiresInSeconds: 60,
        });
        if (url.endsWith("/device/token")) {
          poll += 1;
          return poll === 1
            ? Response.json({ status: "pending", intervalSeconds: 1 }, { status: 202 })
            : Response.json({ status: "approved", token, credentialId: `agc_${"A".repeat(20)}` });
        }
        return Response.json({ status: "acknowledged" });
      },
    });

    await login(runtime, {
      server: "https://commerce-api.merchant.example",
      profileName: "merchant-store",
      openBrowser: true,
    });

    expect(requestedUrls.every((url) => url.startsWith("https://commerce-api.merchant.example/api/v1/"))).toBe(true);
    expect(runtime.openedUrls).toEqual(["https://control.merchant.example/connect"]);
    expect(JSON.stringify({ requestedUrls, openedUrls: runtime.openedUrls })).not.toContain("scalius.com");
  });

  it("revokes remotely before deleting the disk credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-cli-"));
    const token = validToken();
    let sawBearer = false;
    const runtime = createTestRuntime({
      directory,
      fetch: async (_input, init) => {
        sawBearer = new Headers(init?.headers).get("Authorization") === `Bearer ${token}`;
        return Response.json({ status: "revoked" });
      },
    });
    const store = new ConfigStore(runtime);
    await store.putProfile("default", "https://api.example.com");
    await store.putCredential("default", { token, createdAt: "2026-08-13T00:00:00.000Z" });
    await revoke(runtime);
    expect(sawBearer).toBe(true);
    expect((await store.loadCredentials()).credentials.default).toBeUndefined();
  });
});
