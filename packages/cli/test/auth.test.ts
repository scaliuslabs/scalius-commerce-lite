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
    const result = await login(runtime, { server: "https://api.example.com", profileName: "default", openBrowser: true, resource: "dashboard" });
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
      resource: "dashboard",
    });

    expect(requestedUrls.every((url) => url.startsWith("https://commerce-api.merchant.example/api/v1/"))).toBe(true);
    expect(runtime.openedUrls).toEqual(["https://control.merchant.example/connect"]);
    expect(JSON.stringify({ requestedUrls, openedUrls: runtime.openedUrls })).not.toContain("scalius.com");
  });

  it("requests and records a separate storefront audience without changing the merchant origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-storefront-profile-"));
    const token = validToken();
    const requestBodies: unknown[] = [];
    const runtime = createTestRuntime({
      directory,
      fetch: async (input, init) => {
        const url = String(input);
        requestBodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        if (url.endsWith("/device/start")) return Response.json({
          deviceCode: "storefront-device-secret",
          userCode: "BUYER234",
          verificationUri: "https://dashboard.merchant.example/connect",
          intervalSeconds: 1,
          expiresInSeconds: 60,
          resource: "storefront",
        });
        if (url.endsWith("/device/token")) return Response.json({
          status: "approved",
          token,
          credentialId: `agc_${"A".repeat(20)}`,
          resource: "storefront",
        });
        return Response.json({ status: "acknowledged" });
      },
    });

    const result = await login(runtime, {
      server: "https://api.merchant.example",
      profileName: "merchant-storefront",
      openBrowser: false,
      resource: "storefront",
    });

    expect(requestBodies[0]).toEqual({
      clientName: "Scalius CLI",
      profileName: "merchant-storefront",
      resource: "storefront",
    });
    expect(result).toMatchObject({ resource: "storefront", profile: "merchant-storefront" });
    expect((await new ConfigStore(runtime).loadCredentials()).credentials["merchant-storefront"]?.resource).toBe("storefront");
  });

  it("rejects a pairing response that changes the requested audience", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-audience-mismatch-"));
    const runtime = createTestRuntime({
      directory,
      fetch: async () => Response.json({
        deviceCode: "audience-device-secret",
        userCode: "SHOP2345",
        verificationUri: "https://dashboard.merchant.example/connect",
        intervalSeconds: 1,
        expiresInSeconds: 60,
        resource: "dashboard",
      }),
    });

    await expect(login(runtime, {
      server: "https://api.merchant.example",
      profileName: "merchant-storefront",
      openBrowser: false,
      resource: "storefront",
    })).rejects.toMatchObject({ exitCode: 8, errorCode: "invalid_server_response" });
    expect((await new ConfigStore(runtime).loadConfig()).profiles).toEqual({});
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
