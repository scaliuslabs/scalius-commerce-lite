// src/modules/settings/settings-store.ts
// One typed store for every merchant settings document.
//
// A document is declared once with `defineSettingsDocument()` and owns:
//
//   * storage    - exactly one `settings` row: category = document key,
//                  key = "document", value = JSON, revision = optimistic
//                  concurrency counter (0 means "not stored yet").
//   * validation - one zod schema. Reads merge stored fields over the declared
//                  defaults and fail soft to the defaults with a masked warning;
//                  writes throw `ValidationError`.
//   * secrets    - declared fields are encrypted with CREDENTIAL_ENCRYPTION_KEY
//                  and read back with the strict reader, so hot paths never call
//                  a provider with unreadable ciphertext. Obvious placeholders
//                  read as not configured when the document says so.
//   * writes     - always compare-and-swap on the revision that was read, so a
//                  concurrent save can never be silently overwritten. Editors
//                  send the revision they loaded (`expectedRevision`); a stale
//                  one is a 409 SETTINGS_REVISION_CONFLICT. Several documents
//                  saved by one request commit all-or-nothing through
//                  `writeSettingsDocuments()`.
//   * cache      - an optional KV mirror (never for documents with secrets) for
//                  Worker-entry readers that must not open the database.
//
// Relational read failures propagate: checkout and payment readiness must fail
// closed instead of guessing from defaults. Public HTTP caches are not per
// document; route handlers bump the store cache generation after a save.

import type { ZodType } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { settings as settingsTable } from "@scalius/database/schema";
import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import { AppError, ValidationError } from "@scalius/core/errors";
import {
  encodeEncryptedCredential,
  encryptCredentials,
  readStoredCredentialStrict,
} from "@scalius/core/utils/credential-encryption";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The `settings.key` value every document row uses. */
export const SETTINGS_DOCUMENT_ROW_KEY = "document";

export const SETTINGS_REVISION_CONFLICT = "SETTINGS_REVISION_CONFLICT";

/** A save based on a revision that is no longer current. Nothing was written. */
export class SettingsRevisionConflictError extends AppError {
  constructor(document: string, expectedRevision: number, currentRevision: number | null) {
    super(
      409,
      SETTINGS_REVISION_CONFLICT,
      "These settings changed in another session. Reload to see the latest, then save again.",
      { document, expectedRevision, currentRevision },
    );
    this.name = "SettingsRevisionConflictError";
  }
}

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

export interface SettingsDocumentDefinition<T extends object> {
  /** Stored as `settings.category`. */
  key: string;
  schema: ZodType<T>;
  defaults: T;
  /** Secret field -> label used in masked strict-read errors. */
  secretFields?: Partial<Record<keyof T & string, string>>;
  /** Obvious dummy credentials read as not configured. */
  isPlaceholderSecret?: (value: string) => boolean;
  /** KV mirror without expiration. Documents with secrets cannot declare one. */
  cacheKey?: string;
}

/** A stored document row as `selectSettingsDocuments()` returns it. */
export interface SettingsDocumentRow {
  category: string;
  value: string;
  revision: number;
}

export interface SettingsDocumentReadResult<T> {
  value: T;
  /** The stored revision; 0 when the document has never been saved. */
  revision: number;
  /** Whether a row exists (it may still have failed validation). */
  stored: boolean;
  /**
   * A stored row that is not JSON or fails validation; `value` is then the
   * defaults. Checkout authority readers must refuse rather than guess.
   */
  invalid: boolean;
  /** Strict-read failures per secret field. Never contains secret material. */
  secretErrors: Partial<Record<keyof T & string, string>>;
  /** Whether each secret field resolved to a usable, non-placeholder value. */
  secretsConfigured: Partial<Record<keyof T & string, boolean>>;
}

export interface SettingsDocumentWriteOptions extends SettingsBatchOptions {
  /**
   * Compare-and-swap against this revision (0 = the document must not exist).
   * Without it a plain patch is re-applied on a newer document (internal
   * writers only; merchant editors always send the revision they loaded).
   */
  expectedRevision?: number;
  /** Replace the whole document (over the defaults) instead of patching it. */
  replace?: boolean;
}

export interface SettingsBatchOptions {
  /** Statements committed in the same batch before / after the document writes. */
  before?: SQLiteBatchItem[];
  after?: SQLiteBatchItem[];
}

/** One document's part of a `writeSettingsDocuments()` batch. */
export interface SettingsDocumentWriteRequest<T extends object = object> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  document: SettingsDocument<any>;
  patch: Partial<T>;
  ctx?: SettingsDocumentContext;
  expectedRevision?: number;
  replace?: boolean;
}

/** A validated, encoded write that has not been committed yet. */
export interface PreparedSettingsWrite<T extends object> {
  key: string;
  /** The revision the write was built on; the batch fails if it moved. */
  baseRevision: number;
  value: T;
  guard: SQLiteBatchItem;
  statement: SQLiteBatchItem;
  /** Refreshes the KV mirror once the batch committed. */
  committed(): Promise<void>;
}

export interface SettingsDocumentWriteResult<T> {
  value: T;
  revision: number;
}

export interface SettingsDocument<T extends object> {
  readonly key: string;
  readonly defaults: T;
  /** Resolves this document from rows read with `selectSettingsDocuments()`. */
  fromRows(
    rows: readonly SettingsDocumentRow[],
    ctx?: SettingsDocumentContext,
  ): Promise<SettingsDocumentReadResult<T>>;
  read(db: Database, ctx?: SettingsDocumentContext): Promise<T>;
  readDetailed(
    db: Database,
    ctx?: SettingsDocumentContext,
    options?: { skipCache?: boolean },
  ): Promise<SettingsDocumentReadResult<T>>;
  write(
    db: Database,
    patch: Partial<T>,
    ctx?: SettingsDocumentContext,
    options?: SettingsDocumentWriteOptions,
  ): Promise<SettingsDocumentWriteResult<T>>;
  /** Reads, merges, validates and encodes one write; see `writeSettingsDocuments()`. */
  prepareWrite(
    db: Database,
    patch: Partial<T>,
    ctx?: SettingsDocumentContext,
    options?: { expectedRevision?: number; replace?: boolean },
  ): Promise<PreparedSettingsWrite<T>>;
  /** Cache-only read, for Worker-entry paths that must not open the database. */
  readCached(ctx?: SettingsDocumentContext): Promise<T | null>;
  writeCached(ctx: SettingsDocumentContext | undefined, value: T): Promise<void>;
  invalidate(ctx?: SettingsDocumentContext): Promise<void>;
}

/** One batchable read of several documents' rows. */
export function selectSettingsDocuments(
  db: Database,
  documents: readonly { key: string }[],
) {
  return db
    .select({
      category: settingsTable.category,
      value: settingsTable.value,
      revision: settingsTable.revision,
    })
    .from(settingsTable)
    .where(and(
      eq(settingsTable.key, SETTINGS_DOCUMENT_ROW_KEY),
      inArray(settingsTable.category, documents.map((document) => document.key)),
    ));
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

function decodeRecord(raw: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(raw) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const WRITE_ATTEMPTS = 3;
const REVISION_GUARD_MARKER = "SETTINGS_REVISION_CONFLICT";

/** Fails the batch unless the document is still at `revision` (0 = absent). */
function revisionGuard(db: Database, key: string, revision: number): SQLiteBatchItem {
  const matching = sql`SELECT 1 FROM ${settingsTable} WHERE ${settingsTable.key} = ${SETTINGS_DOCUMENT_ROW_KEY} AND ${settingsTable.category} = ${key}`;
  return buildBatchGuard(
    db,
    revision === 0
      ? sql`NOT EXISTS (${matching})`
      : sql`EXISTS (${matching} AND ${settingsTable.revision} = ${revision})`,
    REVISION_GUARD_MARKER,
  );
}

/**
 * Commits one or more document writes in one batch, all-or-nothing: each
 * write is checked against the revision it was built on (and the
 * `expectedRevision` its editor loaded), so a stale write aborts the whole
 * batch, including `before`/`after`. Writes without an expected revision are
 * rebuilt on the newer documents and retried.
 */
export async function writeSettingsDocuments(
  db: Database,
  requests: readonly SettingsDocumentWriteRequest[],
  options: SettingsBatchOptions = {},
): Promise<Array<SettingsDocumentWriteResult<object>>> {
  const before = options.before ?? [];
  const after = options.after ?? [];
  const retryable = requests.every((request) => request.expectedRevision === undefined);
  for (let attempt = 1; ; attempt += 1) {
    const prepared: Array<PreparedSettingsWrite<object>> = [];
    for (const request of requests) {
      prepared.push(await request.document.prepareWrite(db, request.patch, request.ctx, request));
    }
    let results: unknown[] | null = null;
    let failure: unknown = null;
    try {
      results = await safeBatch(db, [
        ...prepared.map((write) => write.guard),
        ...before,
        ...prepared.map((write) => write.statement),
        ...after,
      ] as never) as unknown[];
    } catch (error) {
      failure = error;
    }
    const offset = prepared.length + before.length;
    const written = results
      ? prepared.map((_, index) => (results[offset + index] as Array<{ revision: number }> | undefined)?.[0])
      : [];
    if (results && written.every(Boolean)) {
      await Promise.all(prepared.map((write) => write.committed()));
      return prepared.map((write, index) => ({ value: write.value, revision: written[index]!.revision }));
    }

    // Tell a moved revision apart from any other failure (e.g. a media guard).
    const rows = await selectSettingsDocuments(db, prepared.map((write) => ({ key: write.key })));
    const current = (key: string) => rows.find((row) => row.category === key)?.revision ?? 0;
    const moved = prepared.find((write) => current(write.key) !== write.baseRevision);
    if (!moved && failure) throw failure;
    const conflicted = moved ?? prepared[0]!;
    if (!retryable || attempt >= WRITE_ATTEMPTS) {
      throw new SettingsRevisionConflictError(
        conflicted.key,
        conflicted.baseRevision,
        current(conflicted.key),
      );
    }
  }
}

export function defineSettingsDocument<T extends object>(
  definition: SettingsDocumentDefinition<T>,
): SettingsDocument<T> {
  const label = definition.key;
  const secretFields = Object.keys(definition.secretFields ?? {}) as Array<keyof T & string>;

  if (secretFields.length > 0 && definition.cacheKey) {
    // AGENTS.md: decrypted provider credentials are never written to KV.
    throw new Error(
      `Settings document ${label} declares secret fields and a KV cache. Secrets must not be cached.`,
    );
  }

  function validate(candidate: unknown): { ok: true; value: T } | { ok: false; error: unknown } {
    const result = definition.schema.safeParse(candidate);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error };
  }

  function withDefaults(plain: Record<string, unknown>, where: string): { value: T; invalid: boolean } {
    const validated = validate({ ...definition.defaults, ...plain });
    if (validated.ok) return { value: validated.value, invalid: false };
    // Fail soft: a merchant never loses the storefront to one bad row.
    console.warn(
      `[Settings] ${label} ${where} ${describeValidationFailure(validated.error)}; using defaults.`,
    );
    return { value: { ...definition.defaults }, invalid: true };
  }

  async function resolveRow(
    row: SettingsDocumentRow | undefined,
    ctx: SettingsDocumentContext,
  ): Promise<SettingsDocumentReadResult<T>> {
    const secretErrors: Partial<Record<keyof T & string, string>> = {};
    const secretsConfigured: Partial<Record<keyof T & string, boolean>> = {};
    if (!row) {
      for (const field of secretFields) secretsConfigured[field] = false;
      return { value: { ...definition.defaults }, revision: 0, stored: false, invalid: false, secretErrors, secretsConfigured };
    }

    const plain = decodeRecord(row.value);
    if (!plain) {
      console.warn(`[Settings] ${label} stored value is not a JSON document; using defaults.`);
      for (const field of secretFields) secretsConfigured[field] = false;
      return {
        value: { ...definition.defaults },
        revision: row.revision,
        stored: true,
        invalid: true,
        secretErrors,
        secretsConfigured,
      };
    }

    for (const field of secretFields) {
      const stored = plain[field];
      const result = await readStoredCredentialStrict(
        typeof stored === "string" ? stored : "",
        ctx.encryptionKey,
        definition.secretFields?.[field] ?? `${label} ${field}`,
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

    return {
      ...withDefaults(plain, "stored document"),
      revision: row.revision,
      stored: true,
      secretErrors,
      secretsConfigured,
    };
  }

  async function readRow(db: Database): Promise<SettingsDocumentRow | undefined> {
    const rows = await selectSettingsDocuments(db, [definition]);
    return rows[0];
  }

  async function readCache(ctx: SettingsDocumentContext): Promise<T | null> {
    if (!definition.cacheKey || !ctx.kv) return null;
    let cached: string | null;
    try {
      cached = await ctx.kv.get(definition.cacheKey, { cacheTtl: 60 });
    } catch (error: unknown) {
      console.warn(`[Settings] KV read failed for ${label}:`, maskedMessage(error));
      return null;
    }
    if (cached === null) return null;
    const plain = decodeRecord(cached);
    if (!plain) return null;
    const validated = validate({ ...definition.defaults, ...plain });
    return validated.ok ? validated.value : null;
  }

  async function writeCache(ctx: SettingsDocumentContext, value: T): Promise<void> {
    if (!definition.cacheKey || !ctx.kv) return;
    try {
      await ctx.kv.put(definition.cacheKey, JSON.stringify(value));
    } catch (error: unknown) {
      console.warn(`[Settings] KV write failed for ${label}:`, maskedMessage(error));
    }
  }

  /**
   * Encodes the stored row. A secret the caller did not patch is carried over
   * as the exact stored ciphertext: a save that only changes a neighbouring
   * field never re-encrypts, and never wipes a credential this request had no
   * key to read.
   */
  async function encodeRow(
    value: T,
    patched: ReadonlySet<string>,
    storedPlain: Record<string, unknown> | null,
    ctx: SettingsDocumentContext,
  ): Promise<string> {
    const plain: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of secretFields) {
      if (!patched.has(field) && typeof storedPlain?.[field] === "string") {
        plain[field] = storedPlain[field];
        continue;
      }
      const secret = typeof plain[field] === "string" ? (plain[field] as string).trim() : "";
      if (!secret) {
        plain[field] = "";
        continue;
      }
      if (!ctx.encryptionKey) {
        throw new ValidationError(
          "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.",
        );
      }
      plain[field] = encodeEncryptedCredential(await encryptCredentials(secret, ctx.encryptionKey));
    }
    return JSON.stringify(plain);
  }

  function writeStatement(db: Database, encoded: string, currentRevision: number) {
    if (currentRevision === 0) {
      return db
        .insert(settingsTable)
        .values({
          id: crypto.randomUUID(),
          key: SETTINGS_DOCUMENT_ROW_KEY,
          category: definition.key,
          value: encoded,
          type: "json",
          revision: 1,
        })
        .onConflictDoNothing({ target: [settingsTable.key, settingsTable.category] })
        .returning({ revision: settingsTable.revision });
    }
    return db
      .update(settingsTable)
      .set({
        value: encoded,
        type: "json",
        revision: sql`${settingsTable.revision} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(
        eq(settingsTable.key, SETTINGS_DOCUMENT_ROW_KEY),
        eq(settingsTable.category, definition.key),
        eq(settingsTable.revision, currentRevision),
      ))
      .returning({ revision: settingsTable.revision });
  }

  async function readDetailed(
    db: Database,
    ctx: SettingsDocumentContext = {},
    options: { skipCache?: boolean } = {},
  ): Promise<SettingsDocumentReadResult<T>> {
    if (!options.skipCache) {
      const cached = await readCache(ctx);
      if (cached) {
        return { value: cached, revision: 0, stored: true, invalid: false, secretErrors: {}, secretsConfigured: {} };
      }
    }
    const result = await resolveRow(await readRow(db), ctx);
    // Never cache the defaults that stand in for an unreadable row as if saved.
    if (!result.invalid) await writeCache(ctx, result.value);
    return result;
  }

  async function prepareWrite(
    db: Database,
    patch: Partial<T>,
    ctx: SettingsDocumentContext = {},
    options: { expectedRevision?: number; replace?: boolean } = {},
  ): Promise<PreparedSettingsWrite<T>> {
    const patched = new Set(
      Object.keys(patch).filter((field) => patch[field as keyof T] !== undefined),
    );
    const row = await readRow(db);
    const current = await resolveRow(row, ctx);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new SettingsRevisionConflictError(label, options.expectedRevision, current.revision);
    }

    const merged: Record<string, unknown> = {
      ...((options.replace ? definition.defaults : current.value) as Record<string, unknown>),
    };
    for (const field of patched) merged[field] = patch[field as keyof T];
    const validated = validate(merged);
    if (!validated.ok) {
      throw new ValidationError(
        `${label} settings ${describeValidationFailure(validated.error)}`,
      );
    }

    const encoded = await encodeRow(
      validated.value,
      patched,
      row ? decodeRecord(row.value) : null,
      ctx,
    );
    return {
      key: label,
      baseRevision: current.revision,
      value: validated.value,
      guard: revisionGuard(db, label, current.revision),
      statement: writeStatement(db, encoded, current.revision),
      committed: () => writeCache(ctx, validated.value),
    };
  }

  const document: SettingsDocument<T> = {
    key: definition.key,
    defaults: definition.defaults,
    fromRows(rows, ctx = {}) {
      return resolveRow(rows.find((row) => row.category === definition.key), ctx);
    },
    readDetailed,
    async read(db, ctx) {
      return (await readDetailed(db, ctx)).value;
    },
    async write(db, patch, ctx, options = {}) {
      const [written] = await writeSettingsDocuments(db, [{
        document,
        patch,
        ctx,
        expectedRevision: options.expectedRevision,
        replace: options.replace,
      }], options);
      return written as SettingsDocumentWriteResult<T>;
    },
    prepareWrite,
    readCached(ctx = {}) {
      return readCache(ctx);
    },
    async writeCached(ctx = {}, value) {
      await writeCache(ctx, value);
    },
    async invalidate(ctx = {}) {
      if (!definition.cacheKey || !ctx.kv) return;
      try {
        await ctx.kv.delete(definition.cacheKey);
      } catch (error: unknown) {
        console.warn(`[Settings] KV delete failed for ${label}:`, maskedMessage(error));
      }
    },
  };
  return document;
}
