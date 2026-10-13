import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

vi.mock("./mcp/dashboard", () => ({ DashboardMcpHandler: class {} }));
vi.mock("./mcp/storefront", () => ({ StorefrontMcpHandler: class {} }));
vi.mock("@cloudflare/workers-oauth-provider", () => ({ default: class {} }));

import { purgeExpiredOAuthData, withOAuthKv } from "./oauth";

type OAuthKv = {
  get(key: string, options?: { type: "json" }): Promise<unknown>;
  put(key: string, value: string, options?: { expiration?: number; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
};

describe("OAuth provider storage in system_kv", () => {
  it("keeps provider keys under oauth: and hands the library its own key names back", async () => {
    const { sqlite, binding } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO system_kv (key, value) VALUES ('meta-capi:circuit', '{}')`);
    const env = { DB: binding } as unknown as Env;
    const oauthKv = (withOAuthKv(env) as unknown as { OAUTH_KV: OAuthKv }).OAUTH_KV;

    await oauthKv.put("grant:user_1:grant_1", JSON.stringify({ clientId: "client_1" }));
    await oauthKv.put("client:client_1", "{}", { expirationTtl: 600 });
    await oauthKv.put("token:user_1:grant_1:old", "{}", { expiration: Math.floor(Date.now() / 1000) - 1 });

    const keys = sqlite.prepare("SELECT key FROM system_kv ORDER BY key").all().map((row) => row.key);
    expect(keys).toEqual([
      "meta-capi:circuit",
      "oauth:client:client_1",
      "oauth:grant:user_1:grant_1",
      "oauth:token:user_1:grant_1:old",
    ]);
    // The library lists by its own prefixes and reads each `key.name` back as JSON.
    const grants = await oauthKv.list({ prefix: "grant:" });
    expect(grants).toEqual({ keys: [{ name: "grant:user_1:grant_1" }], list_complete: true });
    await expect(oauthKv.get(grants.keys[0]!.name, { type: "json" })).resolves.toEqual({ clientId: "client_1" });
    await expect(oauthKv.get("client:client_1")).resolves.toBe("{}");
    // An expired token reads as absent, and a full scan sees only live OAuth rows.
    await expect(oauthKv.get("token:user_1:grant_1:old")).resolves.toBeNull();
    const page = await oauthKv.list({ limit: 1 });
    expect(page).toEqual({ keys: [{ name: "client:client_1" }], list_complete: false, cursor: "client:client_1" });
    expect(await oauthKv.list({ limit: 1, cursor: page.cursor })).toEqual({
      keys: [{ name: "grant:user_1:grant_1" }],
      list_complete: true,
    });

    await oauthKv.delete("client:client_1");
    await purgeExpiredOAuthData(env);
    expect(sqlite.prepare("SELECT key FROM system_kv ORDER BY key").all().map((row) => row.key))
      .toEqual(["meta-capi:circuit", "oauth:grant:user_1:grant_1"]);
  });
});
