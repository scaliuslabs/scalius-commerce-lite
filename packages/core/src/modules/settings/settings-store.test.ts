import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "@scalius/core/errors";

import { defineSettingsDocument, selectSettingsDocuments, type SettingsStoreKv } from "./settings-store";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

interface Demo {
  label: string;
  hosts: string[];
  token: string;
}

const demo = defineSettingsDocument<Demo>({
  key: "demo",
  schema: z.object({ label: z.string().max(20), hosts: z.array(z.string()), token: z.string() }),
  defaults: { label: "Store", hosts: [], token: "" },
  secretFields: { token: "Demo token" },
  isPlaceholderSecret: (value) => value === "dummy",
});

const cached = defineSettingsDocument<{ origin: string }>({
  key: "cached",
  schema: z.object({ origin: z.string() }),
  defaults: { origin: "" },
  cacheKey: "settings:cached",
});

function memoryKv(): SettingsStoreKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
  };
}

function authorityRevision(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"]): number {
  return Number((sqlite.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get() as { revision: number }).revision);
}

afterEach(() => vi.restoreAllMocks());

describe("settings documents", () => {
  it("reads defaults at revision 0 until the first save, then one row per document", async () => {
    const { db, sqlite } = createSqliteD1Database();
    expect(await demo.readDetailed(db, { encryptionKey: KEY })).toMatchObject({
      value: { label: "Store", hosts: [], token: "" },
      revision: 0,
      stored: false,
    });

    const saved = await demo.write(db, { label: "Shop" }, { encryptionKey: KEY });
    const second = await demo.write(db, { hosts: ["a.example"] }, { encryptionKey: KEY });

    expect(saved.revision).toBe(1);
    expect(second).toEqual({ value: { label: "Shop", hosts: ["a.example"], token: "" }, revision: 2 });
    expect(sqlite.prepare("SELECT key, category, type, revision FROM settings").all()).toEqual([
      { key: "document", category: "demo", type: "json", revision: 2 },
    ]);
  });

  it("rejects invalid patches and stale expected revisions without writing", async () => {
    const { db } = createSqliteD1Database();
    await demo.write(db, { label: "Shop" });

    await expect(demo.write(db, { label: "x".repeat(21) })).rejects.toBeInstanceOf(ValidationError);
    await expect(demo.write(db, { label: "Late" }, {}, { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(ConflictError);
    const custom = new Error("custom conflict");
    await expect(demo.write(db, { label: "Late" }, {}, { expectedRevision: 5, conflict: () => custom }))
      .rejects.toBe(custom);
    expect((await demo.readDetailed(db)).value.label).toBe("Shop");
  });

  it("never overwrites a save that lands between its read and its write", async () => {
    let raced = false;
    const harness = createSqliteD1Database({
      onQuery: (sql) => {
        if (!raced && /^update "settings"/i.test(sql)) {
          raced = true;
          harness.sqlite.exec(`UPDATE settings SET value = json_set(value, '$.label', 'Concurrent'), revision = revision + 1 WHERE category = 'demo'`);
        }
      },
    });
    await demo.write(harness.db, { label: "Shop" });

    await expect(demo.write(harness.db, { label: "Mine" }, {}, { expectedRevision: 1 }))
      .rejects.toBeInstanceOf(ConflictError);
    expect((await demo.readDetailed(harness.db)).value.label).toBe("Concurrent");

    // A plain patch is re-applied on the newer document instead.
    raced = false;
    await demo.write(harness.db, { hosts: ["b.example"] });
    expect((await demo.readDetailed(harness.db)).value).toMatchObject({ label: "Concurrent", hosts: ["b.example"] });
  });

  it("replaces the whole document over the defaults when asked", async () => {
    const { db } = createSqliteD1Database();
    await demo.write(db, { label: "Shop", hosts: ["a.example"] });
    await demo.write(db, { hosts: ["b.example"] }, {}, { replace: true });
    expect((await demo.readDetailed(db)).value).toMatchObject({ label: "Store", hosts: ["b.example"] });
  });

  it("encrypts secrets, carries unpatched ciphertext, and reads them strictly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, sqlite } = createSqliteD1Database();
    await demo.write(db, { token: "real-token" }, { encryptionKey: KEY });
    const storedToken = () => JSON.parse(
      (sqlite.prepare("SELECT value FROM settings WHERE category = 'demo'").get() as { value: string }).value,
    ).token as string;
    const ciphertext = storedToken();
    expect(ciphertext).toMatch(/^enc:/);
    expect(ciphertext).not.toContain("real-token");

    // A request without the key can still save neighbouring fields.
    await demo.write(db, { label: "Shop" });
    expect(storedToken()).toBe(ciphertext);

    expect(await demo.readDetailed(db, { encryptionKey: KEY })).toMatchObject({
      value: { token: "real-token" },
      secretsConfigured: { token: true },
      secretErrors: {},
    });
    const wrongKey = await demo.readDetailed(db, { encryptionKey: OTHER_KEY });
    expect(wrongKey.value.token).toBe("");
    expect(wrongKey.secretsConfigured.token).toBe(false);
    expect(wrongKey.secretErrors.token).toContain("Demo token");

    await expect(demo.write(db, { token: "another" })).rejects.toBeInstanceOf(ValidationError);
    await demo.write(db, { token: "dummy" }, { encryptionKey: KEY });
    expect(await demo.readDetailed(db, { encryptionKey: KEY })).toMatchObject({
      value: { token: "" },
      secretsConfigured: { token: false },
    });
    await demo.write(db, { token: "" });
    expect(storedToken()).toBe("");
  });

  it("refuses to declare a KV mirror for a document with secrets", () => {
    expect(() => defineSettingsDocument({
      key: "bad",
      schema: z.object({ secret: z.string() }),
      defaults: { secret: "" },
      secretFields: { secret: "Secret" },
      cacheKey: "settings:bad",
    })).toThrow(/Secrets must not be cached/);
  });

  it("writes the KV mirror through and serves Worker-entry reads from it", async () => {
    const { db } = createSqliteD1Database();
    const kv = memoryKv();
    expect(await cached.readCached({ kv })).toBeNull();

    await cached.write(db, { origin: "https://shop.example" }, { kv });
    expect(JSON.parse(kv.store.get("settings:cached")!)).toEqual({ origin: "https://shop.example" });
    expect(await cached.readCached({ kv })).toEqual({ origin: "https://shop.example" });

    kv.store.set("settings:cached", "not-json");
    expect(await cached.readCached({ kv })).toBeNull();
    await cached.invalidate({ kv });
    expect(kv.store.has("settings:cached")).toBe(false);
  });

  it("fails soft to defaults on an unreadable row but propagates relational failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO settings (id, key, value, type, category) VALUES ('x', 'document', '{broken', 'json', 'demo')`);
    expect(await demo.readDetailed(db)).toMatchObject({ value: { label: "Store" }, stored: true, revision: 1 });

    const failing = createSqliteD1Database({
      onQuery: (sql) => {
        if (/from "settings"/i.test(sql)) throw new Error("D1 unavailable");
      },
    });
    await expect(demo.read(failing.db)).rejects.toThrow(/Failed query/);
  });

  it("resolves several documents from one batched read", async () => {
    const { db } = createSqliteD1Database();
    await demo.write(db, { label: "Shop" });
    await cached.write(db, { origin: "https://shop.example" });
    const rows = await selectSettingsDocuments(db, [demo, cached]);
    expect(rows).toHaveLength(2);
    expect((await demo.fromRows(rows)).value.label).toBe("Shop");
    expect((await cached.fromRows(rows)).value.origin).toBe("https://shop.example");
  });

  it("advances the checkout authority revision on every document write", async () => {
    const { db, sqlite } = createSqliteD1Database();
    const before = authorityRevision(sqlite);
    await demo.write(db, { label: "Shop" });
    await demo.write(db, { label: "Shop 2" });
    expect(authorityRevision(sqlite)).toBe(before + 2);
  });
});
