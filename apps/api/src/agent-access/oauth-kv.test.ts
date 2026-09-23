import { describe, expect, it, vi } from "vitest";

vi.mock("./mcp/dashboard", () => ({ DashboardMcpHandler: class {} }));
vi.mock("./mcp/storefront", () => ({ StorefrontMcpHandler: class {} }));
vi.mock("@cloudflare/workers-oauth-provider", () => ({ default: class {} }));

import { withOAuthKv } from "./oauth";

function memoryKv() {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string, options?: { type?: string }) => {
      const value = store.get(key) ?? null;
      return value !== null && options?.type === "json" ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  };
  return { store, kv: kv as unknown as KVNamespace };
}

describe("OAuth provider storage in the shared CACHE namespace", () => {
  it("keeps provider keys under oauth: and hands the library its own key names back", async () => {
    const { store, kv } = memoryKv();
    store.set("rbac:perms:user_1:v1", "[\"orders.view\"]");
    const oauthKv = withOAuthKv({ CACHE: kv } as unknown as Env).OAUTH_KV as KVNamespace;

    await oauthKv.put("grant:user_1:grant_1", JSON.stringify({ clientId: "client_1" }));
    await oauthKv.put("client:client_1", "{}");

    expect([...store.keys()].sort()).toEqual([
      "oauth:client:client_1",
      "oauth:grant:user_1:grant_1",
      "rbac:perms:user_1:v1",
    ]);
    // The library lists by its own prefixes and reads each `key.name` back.
    const grants = await oauthKv.list({ prefix: "grant:" });
    expect(grants.keys.map((key) => key.name)).toEqual(["grant:user_1:grant_1"]);
    // The library reads with `{ type: "json" }`; the options pass through untouched.
    const readJson = oauthKv.get as unknown as (key: string, options: { type: "json" }) => Promise<unknown>;
    await expect(readJson(grants.keys[0]!.name, { type: "json" })).resolves.toEqual({ clientId: "client_1" });
    // A full purge scan never sees or deletes non-OAuth cache entries.
    expect((await oauthKv.list()).keys.map((key) => key.name).sort()).toEqual([
      "client:client_1",
      "grant:user_1:grant_1",
    ]);

    await oauthKv.delete("client:client_1");
    expect(store.has("oauth:client:client_1")).toBe(false);
    expect(store.has("rbac:perms:user_1:v1")).toBe(true);
  });
});
