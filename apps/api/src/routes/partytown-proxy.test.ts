import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

import { CSP_ALLOWED_DOMAINS_CACHE_KEY, partytownProxyRoutes } from "./partytown-proxy";

function createDb(storedValue: string | null) {
  const get = vi.fn(async () => (storedValue === null ? undefined : { value: storedValue }));
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get })),
      })),
    })),
  };
  return { db, get };
}

function createEnv(options: { kv?: string | null; db?: string | null; extra?: Record<string, unknown> } = {}) {
  const kv = {
    get: vi.fn(async () => options.kv ?? null),
    put: vi.fn(async () => undefined),
  };
  const { db, get } = createDb(options.db ?? null);
  mocks.getDb.mockReturnValue(db);
  const env = {
    CACHE: kv,
    DB: { id: "d1" },
    ...options.extra,
  } as unknown as Env;
  return { env, kv, dbGet: get };
}

const TARGET = "https://analytics.tiktok.com/i18n/pixel/events.js";

function proxy(env: Env, target = TARGET) {
  return partytownProxyRoutes.request(`/?url=${encodeURIComponent(target)}`, {}, env);
}

describe("partytown proxy route", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mocks.getDb.mockReset();
  });

  it("allows https analytics script URLs on the KV-mirrored merchant allow-list without touching the database", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("console.log('pixel')", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { env, kv, dbGet } = createEnv({ kv: "analytics.tiktok.com", db: "" });

    const response = await proxy(env);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({ redirect: "follow" }),
    );
    expect(kv.get).toHaveBeenCalledWith(CSP_ALLOWED_DOMAINS_CACHE_KEY);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("falls back to the security settings row on a KV miss and mirrors it back to KV", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { env, kv, dbGet } = createEnv({ kv: null, db: "https://analytics.tiktok.com, *.vendor.example" });

    const response = await proxy(env);

    expect(response.status).toBe(200);
    expect(mocks.getDb).toHaveBeenCalledWith(env);
    expect(dbGet).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(
      CSP_ALLOWED_DOMAINS_CACHE_KEY,
      "https://analytics.tiktok.com, *.vendor.example",
    );
  });

  it("treats an empty KV mirror as an intentionally empty allow-list and does not read the database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env, dbGet } = createEnv({ kv: "", db: "analytics.tiktok.com" });

    const response = await proxy(env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Proxying to this domain is not allowed",
    });
    expect(dbGet).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a CSP_ALLOWED env var; only the dashboard-managed allow-list is trusted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv({
      kv: null,
      db: "",
      extra: { CSP_ALLOWED: "analytics.tiktok.com" },
    });

    const response = await proxy(env);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when neither KV nor the database can provide the allow-list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv({ kv: null });
    mocks.getDb.mockImplementation(() => {
      throw new Error("no database binding");
    });

    const response = await proxy(env);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects configured analytics hosts when the target uses http", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv({ kv: "analytics.tiktok.com" });

    const response = await proxy(env, "http://analytics.tiktok.com/i18n/pixel/events.js");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Proxying this protocol is not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects allowed hosts when the target protocol is not https", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = createEnv({ kv: "analytics.tiktok.com" });

    const response = await proxy(env, "ftp://analytics.tiktok.com/i18n/pixel/events.js");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Proxying this protocol is not allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
