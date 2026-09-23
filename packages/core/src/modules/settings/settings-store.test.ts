import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/database/client")>()),
  safeBatch: mocks.safeBatch,
}));

import { ValidationError } from "@scalius/core/errors";
import {
  defineSettingsDocument,
  rawStringSettingsCodec,
  type SettingsStoreKv,
} from "./settings-store";

const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32)));

interface InsertStatement {
  kind: "insert";
  values: Record<string, unknown>;
  set: Record<string, unknown>;
}

function createDatabase(initialValue: string | null = null) {
  const state = { value: initialValue, deleted: false };
  const statements: InsertStatement[] = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(async () => (state.value === null ? undefined : { value: state.value })),
        })),
        limit: vi.fn(async () => []),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
          const statement: InsertStatement = { kind: "insert", values, set };
          statements.push(statement);
          return statement;
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        state.deleted = true;
        state.value = null;
      }),
    })),
  };
  return { db, state, statements };
}

function createKv() {
  const store = new Map<string, string>();
  const kv: SettingsStoreKv & {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  } = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as never;
  return { kv, store };
}

interface DemoDocument extends Record<string, unknown> {
  enabled: boolean;
  label: string;
  hosts: string[];
}

const demoSchema = z.object({
  enabled: z.boolean(),
  label: z.string().max(10),
  hosts: z.array(z.string()).max(3),
});

function demoDocument(overrides: Record<string, unknown> = {}) {
  return defineSettingsDocument<DemoDocument>({
    category: "demo",
    key: "config",
    schema: demoSchema,
    defaults: { enabled: true, label: "", hosts: [] },
    ...overrides,
  });
}

describe("settings store", () => {
  beforeEach(() => {
    mocks.safeBatch.mockReset().mockResolvedValue([]);
    vi.restoreAllMocks();
  });

  it("returns the declared defaults when nothing is stored", async () => {
    const { db } = createDatabase();
    const document = demoDocument();

    await expect(document.read(db as never)).resolves.toEqual({
      enabled: true,
      label: "",
      hosts: [],
    });
  });

  it("fails soft to defaults with a masked warning when the stored document is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createDatabase(JSON.stringify({ enabled: "yes", label: "x".repeat(50), hosts: {} }));
    const document = demoDocument();

    await expect(document.read(db as never)).resolves.toEqual({
      enabled: true,
      label: "",
      hosts: [],
    });
    const message = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(message).toContain("demo/config");
    expect(message).not.toContain("x".repeat(50));
  });

  it("fails soft to defaults when the stored value is not decodable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createDatabase("{not json");

    await expect(demoDocument().read(db as never)).resolves.toEqual({
      enabled: true,
      label: "",
      hosts: [],
    });
  });

  it("merges a patch onto the stored document and writes one row", async () => {
    const { db, statements } = createDatabase(
      JSON.stringify({ enabled: false, label: "keep", hosts: ["a.example.com"] }),
    );
    const document = demoDocument();

    const saved = await document.write(db as never, { enabled: true });

    expect(saved).toEqual({ enabled: true, label: "keep", hosts: ["a.example.com"] });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toMatchObject({
      category: "demo",
      key: "config",
      type: "json",
      value: JSON.stringify({ enabled: true, label: "keep", hosts: ["a.example.com"] }),
    });
    // One document is one statement, so the write needs no batch round trip.
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });

  it("throws a validation error instead of storing an invalid document", async () => {
    const { db, statements } = createDatabase();

    await expect(
      demoDocument().write(db as never, { label: "far too long to store" }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(statements).toHaveLength(0);
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });

  it("assembles the document from legacy rows and writes it back on first read", async () => {
    const { db, statements } = createDatabase();
    const legacyRead = vi.fn(async () => ({
      document: { enabled: false, label: "legacy" },
      migrate: true,
    }));
    const document = demoDocument({ legacy: { read: legacyRead } });

    await expect(document.read(db as never)).resolves.toEqual({
      enabled: false,
      label: "legacy",
      hosts: [],
    });
    expect(legacyRead).toHaveBeenCalledOnce();
    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toMatchObject({
      value: JSON.stringify({ enabled: false, label: "legacy", hosts: [] }),
    });
  });

  it("skips the legacy write-back when the caller opts out", async () => {
    const { db, statements } = createDatabase();
    const document = demoDocument({
      legacy: {
        read: vi.fn(async () => ({ document: { label: "legacy" }, migrate: true })),
      },
    });

    await expect(
      document.read(db as never, {}, { migrateLegacy: false }),
    ).resolves.toMatchObject({ label: "legacy" });
    expect(statements).toHaveLength(0);
  });

  it("never writes back a legacy document the reader could not fully recover", async () => {
    const { db, statements } = createDatabase();
    const document = demoDocument({
      legacy: {
        read: vi.fn(async () => ({ document: { label: "partial" }, migrate: false })),
      },
    });

    await expect(document.read(db as never)).resolves.toMatchObject({ label: "partial" });
    expect(statements).toHaveLength(0);
  });

  it("does not migrate when there is no legacy document to assemble", async () => {
    const { db, statements } = createDatabase();
    const document = demoDocument({ legacy: { read: vi.fn(async () => null) } });

    await expect(document.read(db as never)).resolves.toEqual({
      enabled: true,
      label: "",
      hosts: [],
    });
    expect(statements).toHaveLength(0);
  });

  it("encrypts declared secret fields and strict-reads them back", async () => {
    const secretSchema = z.object({ token: z.string(), phone: z.string() });
    const document = defineSettingsDocument<{ token: string; phone: string }>({
      category: "provider",
      key: "config",
      schema: secretSchema,
      defaults: { token: "", phone: "" },
      secretFields: ["token"],
    });
    const { db, statements } = createDatabase();

    const saved = await document.write(
      db as never,
      { token: "real-secret", phone: "0170" },
      { encryptionKey: ENCRYPTION_KEY },
    );
    expect(saved).toEqual({ token: "real-secret", phone: "0170" });

    const stored = String(statements[0]?.values.value);
    expect(stored).not.toContain("real-secret");
    const storedDocument = JSON.parse(stored) as Record<string, string>;
    expect(storedDocument.token).toMatch(/^enc:/);
    expect(storedDocument.phone).toBe("0170");

    const reader = createDatabase(stored);
    const detailed = await document.readDetailed(reader.db as never, {
      encryptionKey: ENCRYPTION_KEY,
    });
    expect(detailed.value).toEqual({ token: "real-secret", phone: "0170" });
    expect(detailed.secretErrors).toEqual({});
    expect(detailed.secretsConfigured).toEqual({ token: true });
  });

  it("never returns unreadable ciphertext to a hot path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const document = defineSettingsDocument<{ token: string }>({
      category: "provider",
      key: "config",
      schema: z.object({ token: z.string() }),
      defaults: { token: "" },
      secretFields: ["token"],
    });
    const { db } = createDatabase(JSON.stringify({ token: "enc:not-real-ciphertext" }));

    const detailed = await document.readDetailed(db as never, {
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(detailed.value.token).toBe("");
    expect(detailed.secretsConfigured.token).toBe(false);
    expect(detailed.secretErrors.token).toContain("could not be decrypted");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not-real-ciphertext");
  });

  it("treats an obvious placeholder credential as not configured", async () => {
    const document = defineSettingsDocument<{ token: string }>({
      category: "provider",
      key: "config",
      schema: z.object({ token: z.string() }),
      defaults: { token: "" },
      secretFields: ["token"],
      isPlaceholderSecret: (value) => value === "changeme",
    });
    const { db } = createDatabase(JSON.stringify({ token: "changeme" }));

    const detailed = await document.readDetailed(db as never);

    expect(detailed.value.token).toBe("");
    expect(detailed.secretsConfigured.token).toBe(false);
  });

  it("carries an unpatched secret over verbatim instead of re-encrypting it", async () => {
    const document = defineSettingsDocument<{ token: string; sender: string }>({
      category: "provider",
      key: "config",
      schema: z.object({ token: z.string(), sender: z.string() }),
      defaults: { token: "", sender: "" },
      secretFields: ["token"],
    });
    const { db, statements } = createDatabase();

    await document.write(
      db as never,
      { token: "real-secret", sender: "a@example.com" },
      { encryptionKey: ENCRYPTION_KEY },
    );
    const firstStored = String(statements[0]?.values.value);
    const firstCiphertext = (JSON.parse(firstStored) as Record<string, string>).token;

    // A later save with no credential key at hand must not wipe the secret.
    const reader = createDatabase(firstStored);
    await document.write(reader.db as never, { sender: "b@example.com" });

    const secondStored = JSON.parse(String(reader.statements[0]?.values.value)) as Record<string, string>;
    expect(secondStored.token).toBe(firstCiphertext);
    expect(secondStored.sender).toBe("b@example.com");
  });

  it("refuses to store a secret without the credential encryption key", async () => {
    const document = defineSettingsDocument<{ token: string }>({
      category: "provider",
      key: "config",
      schema: z.object({ token: z.string() }),
      defaults: { token: "" },
      secretFields: ["token"],
    });
    const { db, statements } = createDatabase();

    await expect(document.write(db as never, { token: "real-secret" })).rejects.toThrow(
      "CREDENTIAL_ENCRYPTION_KEY",
    );
    expect(statements).toHaveLength(0);
  });

  it("refuses to define a cached document that holds secrets", () => {
    expect(() =>
      defineSettingsDocument<{ token: string }>({
        category: "provider",
        key: "config",
        schema: z.object({ token: z.string() }),
        defaults: { token: "" },
        secretFields: ["token"],
        cache: { key: "provider:config", ttlSeconds: 60 },
      }),
    ).toThrow("must not be cached");
  });

  it("reads through KV with a 60 second cacheTtl and writes through on save", async () => {
    const { kv, store } = createKv();
    const { db } = createDatabase(JSON.stringify({ enabled: false, label: "db", hosts: [] }));
    const document = demoDocument({ cache: { key: "demo:config:v1", ttlSeconds: 300 } });

    await expect(document.read(db as never, { kv })).resolves.toMatchObject({ label: "db" });
    expect(kv.get).toHaveBeenCalledWith("demo:config:v1", { cacheTtl: 60 });
    expect(store.get("demo:config:v1")).toBe(
      JSON.stringify({ enabled: false, label: "db", hosts: [] }),
    );

    db.select.mockClear();
    await expect(document.read(db as never, { kv })).resolves.toMatchObject({ label: "db" });
    expect(db.select).not.toHaveBeenCalled();

    await document.write(db as never, { label: "next" }, { kv });
    expect(kv.put).toHaveBeenLastCalledWith(
      "demo:config:v1",
      JSON.stringify({ enabled: false, label: "next", hosts: [] }),
      { expirationTtl: 300 },
    );

    await document.invalidate({ kv });
    expect(kv.delete).toHaveBeenCalledWith("demo:config:v1");
    expect(store.has("demo:config:v1")).toBe(false);
  });

  it("persists a mirror without an expiration when the declared TTL is zero", async () => {
    const { kv } = createKv();
    const { db } = createDatabase();
    const document = defineSettingsDocument<{ sources: string }>({
      category: "security",
      key: "csp_allowed_domains",
      schema: z.object({ sources: z.string() }),
      defaults: { sources: "" },
      codec: rawStringSettingsCodec("sources"),
      cache: { key: "security:csp_allowed_domains", ttlSeconds: 0 },
    });

    await document.write(db as never, { sources: "https://a.example.com" }, { kv });

    expect(kv.put).toHaveBeenCalledWith(
      "security:csp_allowed_domains",
      "https://a.example.com",
    );
  });

  it("keeps a raw-codec row byte-identical for readers outside the store", async () => {
    const { db, statements } = createDatabase();
    const document = defineSettingsDocument<{ sources: string }>({
      category: "security",
      key: "csp_allowed_domains",
      schema: z.object({ sources: z.string() }),
      defaults: { sources: "" },
      codec: rawStringSettingsCodec("sources"),
    });

    await document.write(db as never, { sources: "https://a.example.com,https://b.example.com" });

    expect(statements[0]?.values).toMatchObject({
      type: "string",
      value: "https://a.example.com,https://b.example.com",
    });

    const reader = createDatabase("https://a.example.com,https://b.example.com");
    await expect(document.read(reader.db as never)).resolves.toEqual({
      sources: "https://a.example.com,https://b.example.com",
    });
  });

  it("reads and writes site_settings columns through the same interface", async () => {
    const columnWrite = vi.fn(async () => undefined);
    const { db, statements } = createDatabase(JSON.stringify({ label: "doc" }));
    const document = defineSettingsDocument<{ label: string; siteName: string }>({
      category: "demo",
      key: "columns",
      schema: z.object({ label: z.string(), siteName: z.string() }),
      defaults: { label: "", siteName: "" },
      columns: {
        fields: ["siteName"],
        read: async () => ({ siteName: "My Store" }),
        write: columnWrite,
      },
    });

    await expect(document.read(db as never)).resolves.toEqual({
      label: "doc",
      siteName: "My Store",
    });

    await document.write(db as never, { siteName: "Renamed" });
    expect(columnWrite).toHaveBeenCalledWith(db, { siteName: "Renamed" });
    // A column-only patch must not rewrite the document row.
    expect(statements).toHaveLength(0);
  });

  it("removes the stored row and the cache entry", async () => {
    const { kv, store } = createKv();
    store.set("demo:config:v1", "{}");
    const { db, state } = createDatabase("{}");
    const document = demoDocument({ cache: { key: "demo:config:v1", ttlSeconds: 300 } });

    await document.remove(db as never, { kv });

    expect(state.deleted).toBe(true);
    expect(kv.delete).toHaveBeenCalledWith("demo:config:v1");
  });
});
