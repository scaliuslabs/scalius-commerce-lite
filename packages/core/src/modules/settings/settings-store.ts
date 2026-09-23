// src/modules/settings/settings-store.ts
// One typed store for merchant settings documents.
//
// Every migrated settings surface is declared once with
// `defineSettingsDocument()` instead of hand-written get/save/cache/invalidate
// helpers. A document owns:
//
//   * storage    - exactly one row in `settings` for its (category, key), so a
//                  new field is a schema change, not a new row plus a new
//                  reader plus a new writer.
//   * validation - one zod schema. Reads fail soft to the declared defaults
//                  with a masked warning; writes throw `ValidationError`.
//   * secrets    - declared fields are encrypted with the existing credential
//                  helpers and read back with the strict reader, so hot paths
//                  never call a provider with unreadable ciphertext.
//   * legacy     - an optional reader that assembles the document from the
//                  pre-migration per-key rows and writes the document back on
//                  the first read, so no D1 migration is required.
//   * cache      - one KV key with one declared TTL, read with `cacheTtl: 60`,
//                  written through on save, deleted by `invalidate()`.
//   Public HTTP caches are not per document: route handlers bump the store
//   cache generation after a successful save.

import type { ZodType } from "zod";
import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { settings as settingsTable } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
  encodeEncryptedCredential,
  encryptCredentials,
  readStoredCredentialStrict,
} from "@scalius/core/utils/credential-encryption";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The KV surface the store needs. Cloudflare `KVNamespace` satisfies it. */
export interface SettingsStoreKv {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Per-request capabilities. Both are optional so reads degrade, never crash. */
export interface SettingsDocumentContext {
  kv?: SettingsStoreKv | null;
  /** Must be the dedicated CREDENTIAL_ENCRYPTION_KEY, never a JWT fallback. */
  encryptionKey?: string;
}

/**
 * Converts between the stored `settings.value` string and a plain record.
 * The default is JSON. A raw codec keeps a pre-migration single-value row
 * byte-identical for readers outside this store (the CSP allow-list row and
 * KV mirror are read directly by the storefront CSP handler and the Partytown
 * proxy, and must stay a bare comma-separated string).
 */
export interface SettingsDocumentCodec {
  encode(plain: Record<string, unknown>): string;
  decode(raw: string): unknown;
}

export const JSON_SETTINGS_CODEC: SettingsDocumentCodec = {
  encode: (plain) => JSON.stringify(plain),
  decode: (raw) => JSON.parse(raw) as unknown,
};

/** Codec for a document whose stored row is one bare string field. */
export function rawStringSettingsCodec(field: string): SettingsDocumentCodec {
  return {
    encode: (plain) => {
      const value = plain[field];
      return typeof value === "string" ? value : String(value ?? "");
    },
    decode: (raw) => ({ [field]: raw }),
  };
}

/**
 * Fields that stay in the wide `site_settings` singleton row. They are read
 * through the document so callers see one shape; `write` is optional and a
 * patch touching a read-only column field is a programming error.
 */
export interface SettingsDocumentColumns<T> {
  fields: readonly (keyof T & string)[];
  read(db: Database): Promise<Partial<T>>;
  write?(db: Database, patch: Partial<T>): Promise<void>;
}

export interface SettingsDocumentLegacyResult<T> {
  /** The fields recovered from the pre-migration rows. */
  document: Partial<T>;
  /**
   * Whether the assembled document may replace the legacy rows. A reader that
   * could not recover a secret (no credential key at hand, unreadable
   * ciphertext) must return `false` so the write-back cannot erase it.
   */
  migrate: boolean;
  /** Strict-read failures for secret fields, surfaced like a document read. */
  secretErrors?: Partial<Record<keyof T & string, string>>;
  secretsConfigured?: Partial<Record<keyof T & string, boolean>>;
}

/** Assembles the document from the pre-migration per-key rows. */
export interface SettingsDocumentLegacy<T> {
  read(
    db: Database,
    ctx: SettingsDocumentContext,
  ): Promise<SettingsDocumentLegacyResult<T> | null>;
}

export interface SettingsDocumentCache {
  key: string;
  /** `0` persists without an expiration (a mirror other Workers read). */
  ttlSeconds: number;
}

export interface SettingsDocumentDefinition<T extends object> {
  category: string;
  /** Defaults to `"document"`. One row per (category, key). */
  key?: string;
  schema: ZodType<T>;
  defaults: T;
  /** Encrypted at rest with CREDENTIAL_ENCRYPTION_KEY, strict-read back. */
  secretFields?: readonly (keyof T & string)[];
  /** Obvious dummy credentials read as not configured. */
  isPlaceholderSecret?: (value: string) => boolean;
  cache?: SettingsDocumentCache;
  legacy?: SettingsDocumentLegacy<T>;
  columns?: SettingsDocumentColumns<T>;
  codec?: SettingsDocumentCodec;
  /** `settings.type`. Defaults to `"json"`, or `"string"` for a raw codec. */
  storageType?: string;
  /** Short label used in masked warnings. Defaults to `category/key`. */
  label?: string;
}

export type SettingsDocumentSource = "cache" | "document" | "legacy" | "defaults";

export interface SettingsDocumentReadOptions {
  /** Bypass KV. Admin reads use this so a save is visible immediately. */
  skipCache?: boolean;
  /** Assemble and write back legacy rows on a miss. Defaults to `true`. */
  migrateLegacy?: boolean;
}

export interface SettingsDocumentReadResult<T> {
  value: T;
  source: SettingsDocumentSource;
  /** Strict-read failures per secret field. Never contains secret material. */
  secretErrors: Partial<Record<keyof T & string, string>>;
  /** Whether each secret field resolved to a usable, non-placeholder value. */
  secretsConfigured: Partial<Record<keyof T & string, boolean>>;
}

export interface SettingsDocumentPreparedWrite<T> {
  /** The validated document as callers see it, with plaintext secrets. */
  value: T;
  /** Batchable statements. Empty when every patched field is column-backed. */
  statements: SQLiteBatchItem[];
  /** Write through to KV. Call only after the statements commit. */
  commitCache(): Promise<void>;
}

export interface SettingsDocument<T extends object> {
  readonly category: string;
  readonly key: string;
  readonly defaults: T;
  readonly cacheKey: string | null;
  read(
    db: Database,
    ctx?: SettingsDocumentContext,
    options?: SettingsDocumentReadOptions,
  ): Promise<T>;
  readDetailed(
    db: Database,
    ctx?: SettingsDocumentContext,
    options?: SettingsDocumentReadOptions,
  ): Promise<SettingsDocumentReadResult<T>>;
  write(
    db: Database,
    patch: Partial<T>,
    ctx?: SettingsDocumentContext,
  ): Promise<T>;
  /** Build the write for callers that batch it with related statements. */
  prepareWrite(
    db: Database,
    patch: Partial<T>,
    ctx?: SettingsDocumentContext,
  ): Promise<SettingsDocumentPreparedWrite<T>>;
  /** Cache-only read, for Worker-entry paths that must not open the database. */
  readCached(ctx?: SettingsDocumentContext): Promise<T | null>;
  /** Write a resolved document straight to the cache. */
  writeCached(ctx: SettingsDocumentContext | undefined, value: T): Promise<void>;
  /** Delete the stored row and the cache entry. Column fields are untouched. */
  remove(db: Database, ctx?: SettingsDocumentContext): Promise<void>;
  invalidate(ctx?: SettingsDocumentContext): Promise<void>;
}

function maskedMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeValidationFailure(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> })?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return "is not valid";
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
      return path ? `${path}: ${issue.message ?? "invalid"}` : issue.message ?? "invalid";
    })
    .join("; ");
}

export function defineSettingsDocument<T extends object>(
  definition: SettingsDocumentDefinition<T>,
): SettingsDocument<T> {
  const key = definition.key ?? "document";
  const label = definition.label ?? `${definition.category}/${key}`;
  const secretFields = definition.secretFields ?? [];
  const columnFields = new Set<string>(definition.columns?.fields ?? []);
  const codec = definition.codec ?? JSON_SETTINGS_CODEC;
  const storageType = definition.storageType ?? (definition.codec ? "string" : "json");

  if (secretFields.length > 0 && definition.cache) {
    // AGENTS.md: decrypted provider credentials are never written to KV.
    throw new Error(
      `Settings document ${label} declares secret fields and a KV cache. Secrets must not be cached.`,
    );
  }
  for (const field of secretFields) {
    if (columnFields.has(field)) {
      throw new Error(
        `Settings document ${label} declares ${field} as both a secret and a site_settings column.`,
      );
    }
  }

  const documentFields = (Object.keys(definition.defaults) as Array<keyof T & string>)
    .filter((field) => !columnFields.has(field));

  function validate(candidate: unknown): { ok: true; value: T } | { ok: false; error: unknown } {
    const result = definition.schema.safeParse(candidate);
    return result.success
      ? { ok: true, value: result.data }
      : { ok: false, error: result.error };
  }

  async function readStoredRow(db: Database): Promise<string | null> {
    const row = await db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(and(
        eq(settingsTable.category, definition.category),
        eq(settingsTable.key, key),
      ))
      .get();
    return row?.value ?? null;
  }

  async function decodeStored(
    raw: string,
    ctx: SettingsDocumentContext,
  ): Promise<{
    plain: Record<string, unknown>;
    secretErrors: Partial<Record<keyof T & string, string>>;
    secretsConfigured: Partial<Record<keyof T & string, boolean>>;
  } | null> {
    let decoded: unknown;
    try {
      decoded = codec.decode(raw);
    } catch (error: unknown) {
      console.warn(`[Settings] ${label} stored value is not decodable:`, maskedMessage(error));
      return null;
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      console.warn(`[Settings] ${label} stored value is not a document.`);
      return null;
    }

    const plain = { ...(decoded as Record<string, unknown>) };
    const secretErrors: Partial<Record<keyof T & string, string>> = {};
    const secretsConfigured: Partial<Record<keyof T & string, boolean>> = {};

    for (const field of secretFields) {
      const stored = plain[field];
      const result = await readStoredCredentialStrict(
        typeof stored === "string" ? stored : "",
        ctx.encryptionKey,
        `${label} ${field}`,
      );
      if (result.error) {
        // Masked: the message never contains credential material.
        console.warn(`[Settings] ${label} ${field} is not readable:`, result.error);
        secretErrors[field] = result.error;
        plain[field] = definition.defaults[field];
        secretsConfigured[field] = false;
        continue;
      }
      const placeholder = Boolean(result.value)
        && Boolean(definition.isPlaceholderSecret?.(result.value));
      plain[field] = placeholder ? definition.defaults[field] : result.value;
      secretsConfigured[field] = Boolean(result.value) && !placeholder;
    }

    return { plain, secretErrors, secretsConfigured };
  }

  /**
   * The stored row holds only the fields this document owns; column-backed
   * fields stay in `site_settings`.
   */
  async function encodeDocumentRow(
    value: T,
    ctx: SettingsDocumentContext,
    /**
     * Secret ciphertext exactly as it is stored today. A secret the caller did
     * not patch is carried over verbatim: a save that only changes a
     * neighbouring field must never re-encrypt, and must never wipe a
     * credential this request had no key to read.
     */
    untouchedSecrets: Record<string, string> = {},
  ): Promise<string> {
    const plain: Record<string, unknown> = {};
    for (const field of documentFields) {
      plain[field] = value[field];
    }
    for (const field of secretFields) {
      const carried = untouchedSecrets[field];
      if (carried !== undefined) {
        plain[field] = carried;
        continue;
      }
      const secret = plain[field];
      const trimmed = typeof secret === "string" ? secret : "";
      if (!trimmed) {
        plain[field] = "";
        continue;
      }
      if (!ctx.encryptionKey) {
        throw new ValidationError(
          "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.",
        );
      }
      plain[field] = encodeEncryptedCredential(
        await encryptCredentials(trimmed, ctx.encryptionKey),
      );
    }
    return codec.encode(plain);
  }

  /** The stored ciphertext for every secret field the caller is not patching. */
  async function readUntouchedSecrets(
    db: Database,
    patched: ReadonlySet<string>,
  ): Promise<Record<string, string>> {
    if (secretFields.length === 0) return {};
    if (secretFields.every((field) => patched.has(field))) return {};

    let stored: string | null;
    try {
      stored = await readStoredRow(db);
    } catch {
      return {};
    }
    if (stored === null) return {};

    let decoded: unknown;
    try {
      decoded = codec.decode(stored);
    } catch {
      return {};
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return {};

    const carried: Record<string, string> = {};
    for (const field of secretFields) {
      if (patched.has(field)) continue;
      const value = (decoded as Record<string, unknown>)[field];
      if (typeof value === "string") carried[field] = value;
    }
    return carried;
  }

  /**
   * The cache snapshot is the whole resolved document, column-backed fields
   * included, so a KV hit answers without touching the relational provider.
   * Documents with secret fields cannot declare a cache, so this never
   * serializes credential material.
   */
  function encodeCacheSnapshot(value: T): string {
    const plain: Record<string, unknown> = {};
    for (const field of Object.keys(value) as Array<keyof T & string>) {
      plain[field] = value[field];
    }
    return codec.encode(plain);
  }

  async function readCache(ctx: SettingsDocumentContext): Promise<string | null> {
    if (!definition.cache || !ctx.kv) return null;
    try {
      return await ctx.kv.get(definition.cache.key, { cacheTtl: 60 });
    } catch (error: unknown) {
      console.warn(`[Settings] KV read failed for ${label}:`, maskedMessage(error));
      return null;
    }
  }

  async function writeCache(ctx: SettingsDocumentContext, encoded: string): Promise<void> {
    if (!definition.cache || !ctx.kv) return;
    try {
      if (definition.cache.ttlSeconds > 0) {
        await ctx.kv.put(definition.cache.key, encoded, {
          expirationTtl: definition.cache.ttlSeconds,
        });
      } else {
        await ctx.kv.put(definition.cache.key, encoded);
      }
    } catch (error: unknown) {
      console.warn(`[Settings] KV write failed for ${label}:`, maskedMessage(error));
    }
  }

  async function deleteCache(ctx: SettingsDocumentContext): Promise<void> {
    if (!definition.cache || !ctx.kv) return;
    try {
      await ctx.kv.delete(definition.cache.key);
    } catch (error: unknown) {
      console.warn(`[Settings] KV delete failed for ${label}:`, maskedMessage(error));
    }
  }

  function upsertStatement(db: Database, encoded: string): SQLiteBatchItem {
    return db
      .insert(settingsTable)
      .values({
        id: crypto.randomUUID(),
        key,
        value: encoded,
        type: storageType,
        category: definition.category,
      })
      .onConflictDoUpdate({
        target: [settingsTable.key, settingsTable.category],
        set: { value: encoded, type: storageType, updatedAt: sql`unixepoch()` },
      }) as SQLiteBatchItem;
  }

  function finish(
    plain: Record<string, unknown>,
    source: SettingsDocumentSource,
    secretErrors: Partial<Record<keyof T & string, string>>,
    secretsConfigured: Partial<Record<keyof T & string, boolean>>,
  ): SettingsDocumentReadResult<T> {
    const validated = validate({ ...definition.defaults, ...plain });
    if (validated.ok) {
      return { value: validated.value, source, secretErrors, secretsConfigured };
    }
    // Fail soft: a merchant never loses the storefront to one bad row.
    console.warn(
      `[Settings] ${label} stored document ${describeValidationFailure(validated.error)}; using defaults.`,
    );
    return {
      value: { ...definition.defaults },
      source: "defaults",
      secretErrors,
      secretsConfigured,
    };
  }

  async function readDetailed(
    db: Database,
    ctx: SettingsDocumentContext = {},
    options: SettingsDocumentReadOptions = {},
  ): Promise<SettingsDocumentReadResult<T>> {
    if (!options.skipCache) {
      const cached = await readCache(ctx);
      if (cached !== null) {
        const decoded = await decodeStored(cached, ctx);
        if (decoded) {
          return finish(
            decoded.plain,
            "cache",
            decoded.secretErrors,
            decoded.secretsConfigured,
          );
        }
      }
    }

    const columnValues = definition.columns
      ? await definition.columns.read(db).catch((error: unknown) => {
        console.warn(`[Settings] ${label} column read failed:`, maskedMessage(error));
        return {} as Partial<T>;
      })
      : ({} as Partial<T>);

    let stored: string | null;
    try {
      stored = await readStoredRow(db);
    } catch (error: unknown) {
      console.error(`[Settings] DB read failed for ${label}:`, maskedMessage(error));
      return finish({ ...columnValues }, "defaults", {}, {});
    }

    if (stored !== null) {
      const decoded = await decodeStored(stored, ctx);
      if (decoded) {
        const result = finish(
          { ...decoded.plain, ...columnValues },
          "document",
          decoded.secretErrors,
          decoded.secretsConfigured,
        );
        await writeCache(ctx, encodeCacheSnapshot(result.value));
        return result;
      }
      return finish({ ...columnValues }, "defaults", {}, {});
    }

    if (definition.legacy) {
      let assembled: SettingsDocumentLegacyResult<T> | null = null;
      try {
        assembled = await definition.legacy.read(db, ctx);
      } catch (error: unknown) {
        console.warn(`[Settings] ${label} legacy read failed:`, maskedMessage(error));
      }
      if (assembled) {
        const result = finish(
          { ...assembled.document, ...columnValues },
          "legacy",
          assembled.secretErrors ?? {},
          assembled.secretsConfigured ?? {},
        );
        if (options.migrateLegacy !== false && assembled.migrate) {
          // Best effort: a failed write-back must not fail the read.
          try {
            const encoded = await encodeDocumentRow(result.value, ctx);
            await runStatements(db, [upsertStatement(db, encoded)]);
          } catch (error: unknown) {
            console.warn(
              `[Settings] ${label} legacy write-back failed:`,
              maskedMessage(error),
            );
          }
        }
        // The cache holds the resolved document whether or not the write-back
        // landed, so a read-only failure cannot pin every request to the
        // relational provider.
        await writeCache(ctx, encodeCacheSnapshot(result.value));
        return result;
      }
    }

    return finish({ ...columnValues }, "defaults", {}, {});
  }

  /**
   * One document is one statement, so the common path is a plain write; the
   * batch helper is only needed when a caller appends related statements.
   */
  async function runStatements(db: Database, statements: SQLiteBatchItem[]): Promise<void> {
    if (statements.length === 0) return;
    if (statements.length === 1) {
      await statements[0];
      return;
    }
    await safeBatch(db, statements as never);
  }

  async function prepareWrite(
    db: Database,
    patch: Partial<T>,
    ctx: SettingsDocumentContext = {},
  ): Promise<SettingsDocumentPreparedWrite<T>> {
    const patchedFields = Object.keys(patch).filter(
      (field) => patch[field as keyof T] !== undefined,
    );
    for (const field of patchedFields) {
      if (columnFields.has(field) && !definition.columns?.write) {
        throw new Error(
          `Settings document ${label} cannot write the site_settings column ${field}.`,
        );
      }
    }

    const current = await readDetailed(db, ctx, { skipCache: true, migrateLegacy: false });
    const merged: Record<string, unknown> = { ...(current.value as Record<string, unknown>) };
    for (const field of patchedFields) {
      merged[field] = patch[field as keyof T];
    }

    const validated = validate(merged);
    if (!validated.ok) {
      throw new ValidationError(
        `${label} settings ${describeValidationFailure(validated.error)}`,
      );
    }
    const value = validated.value;

    const touchesDocument = patchedFields.some((field) => !columnFields.has(field))
      || (documentFields.length > 0 && patchedFields.length === 0);
    const encoded = touchesDocument
      ? await encodeDocumentRow(
        value,
        ctx,
        await readUntouchedSecrets(db, new Set(patchedFields)),
      )
      : null;

    if (definition.columns?.write) {
      const columnPatch: Partial<T> = {};
      let hasColumnPatch = false;
      for (const field of patchedFields) {
        if (!columnFields.has(field)) continue;
        // Column adapters own their own normalization and validation, so they
        // receive the caller's value rather than the document-normalized one.
        columnPatch[field as keyof T] = patch[field as keyof T];
        hasColumnPatch = true;
      }
      if (hasColumnPatch) await definition.columns.write(db, columnPatch);
    }

    return {
      value,
      statements: encoded === null ? [] : [upsertStatement(db, encoded)],
      commitCache: async () => {
        await writeCache(ctx, encodeCacheSnapshot(value));
      },
    };
  }

  return {
    category: definition.category,
    key,
    defaults: definition.defaults,
    cacheKey: definition.cache?.key ?? null,
    readDetailed,
    async read(db, ctx, options) {
      return (await readDetailed(db, ctx, options)).value;
    },
    async readCached(ctx = {}) {
      const cached = await readCache(ctx);
      if (cached === null) return null;
      const decoded = await decodeStored(cached, ctx);
      if (!decoded) return null;
      const result = finish(decoded.plain, "cache", decoded.secretErrors, decoded.secretsConfigured);
      return result.source === "defaults" ? null : result.value;
    },
    async writeCached(ctx = {}, value) {
      await writeCache(ctx, encodeCacheSnapshot(value));
    },
    prepareWrite,
    async write(db, patch, ctx = {}) {
      const prepared = await prepareWrite(db, patch, ctx);
      await runStatements(db, prepared.statements);
      await prepared.commitCache();
      return prepared.value;
    },
    async remove(db, ctx = {}) {
      await db.delete(settingsTable).where(and(
        eq(settingsTable.category, definition.category),
        eq(settingsTable.key, key),
      ));
      await deleteCache(ctx);
    },
    async invalidate(ctx = {}) {
      await deleteCache(ctx);
    },
  };
}
