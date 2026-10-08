// Plugin logs (`ctx.log`): a bounded ring of each plugin's newest lines,
// shown in the plugin's dashboard log. Everything is masked before it is
// written: the plugin's own secret settings, credential-looking keys and
// values, e-mail addresses and phone numbers. Host incidents (a throw, a
// timeout, an invalid output) are written here too, under source `host`.

import type { Database } from "@scalius/database/client";
import { chunkRowsForD1, safeBatch } from "@scalius/database/client";
import { pluginLogEntries, type PluginLogLevel } from "@scalius/database/schema";
import { and, desc, eq, lt } from "drizzle-orm";

export const PLUGIN_LOG_RING_SIZE = 500;
export const PLUGIN_LOG_MESSAGE_MAX = 500;
export const PLUGIN_LOG_FIELDS_MAX_BYTES = 4096;
/** Lines one invocation may write; the rest collapse into one "N more lines" line. */
export const PLUGIN_LOG_LINES_PER_WRITE = 50;
const SOURCE_MAX = 80;
const LEVELS: readonly PluginLogLevel[] = ["debug", "info", "warn", "error"];

export interface PluginLogInput {
  level: PluginLogLevel;
  source: string;
  message: string;
  fields?: Record<string, unknown>;
}

export interface PluginLogLine {
  id: string;
  level: PluginLogLevel;
  source: string;
  message: string;
  fields: Record<string, unknown>;
  createdAt: number;
}

const SECRET_KEY = /pass(word)?|secret|token|auth|api[_-]?key|private|credential|cookie|session|otp|pin\b|cvv|card/i;

/** Masks secrets, credentials, e-mail addresses and phone numbers in one string. */
export function maskPluginLogText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join("[secret]");
  }
  return text
    .replace(/[^\P{Cc}\t\n\r]+/gu, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[number]");
}

function maskValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return maskPluginLogText(value.slice(0, 200), secrets);
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => maskValue(item, secrets, depth + 1));
  if (typeof value === "object") {
    const masked: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      const safeKey = key.slice(0, 40);
      masked[safeKey] = SECRET_KEY.test(key) ? "[masked]" : maskValue(item, secrets, depth + 1);
    }
    return masked;
  }
  return String(value).slice(0, 80);
}

/** Masked, bounded fields (at most 4 KiB of JSON; larger fields collapse to a note). */
export function maskPluginLogFields(fields: Record<string, unknown> | undefined, secrets: readonly string[] = []): Record<string, unknown> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const masked = maskValue(fields, secrets, 0) as Record<string, unknown>;
  const json = JSON.stringify(masked);
  return new TextEncoder().encode(json).byteLength <= PLUGIN_LOG_FIELDS_MAX_BYTES ? masked : { truncated: true };
}

// Ids sort in write order: the newest list reads `id` descending. Lines written
// in the same millisecond by separate calls (a host error, then its quota
// breach) keep their order through a per-isolate counter; the random tail only
// keeps ids unique across isolates. Not merchant state: a clock tie-breaker.
let lastLogTimestamp = 0;
let logCounter = 0;

function logId(timestamp: number): string {
  if (timestamp > lastLogTimestamp) {
    lastLogTimestamp = timestamp;
    logCounter = 0;
  } else {
    logCounter += 1;
  }
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `plg_${String(lastLogTimestamp).padStart(13, "0")}${(logCounter % 0x10000).toString(16).padStart(4, "0")}${random}`;
}

function normalizeEntry(entry: PluginLogInput, secrets: readonly string[]) {
  const level = LEVELS.includes(entry.level) ? entry.level : "info";
  const source = (typeof entry.source === "string" && entry.source.trim() ? entry.source.trim() : "plugin").slice(0, SOURCE_MAX);
  const raw = typeof entry.message === "string" ? entry.message : String(entry.message);
  const message = maskPluginLogText(raw, secrets).trim().slice(0, PLUGIN_LOG_MESSAGE_MAX) || "(empty message)";
  return { level, source, message, fieldsJson: JSON.stringify(maskPluginLogFields(entry.fields, secrets)) };
}

/**
 * Appends masked lines and trims the plugin's ring to its newest 500, in one
 * batch. `secrets` are the plugin's opened secret settings, never written.
 */
export async function writePluginLogs(
  db: Database,
  pluginId: string,
  entries: readonly PluginLogInput[],
  options: { secrets?: readonly string[] } = {},
): Promise<number> {
  if (entries.length === 0) return 0;
  const secrets = options.secrets ?? [];
  const kept = entries.slice(0, PLUGIN_LOG_LINES_PER_WRITE);
  if (entries.length > kept.length) {
    kept.push({ level: "warn", source: "host", message: `${entries.length - kept.length} more log lines from this run were dropped.` });
  }
  const now = Date.now();
  const rows = kept.map((entry) => ({
    id: logId(now),
    pluginId,
    ...normalizeEntry(entry, secrets),
    createdAt: Math.floor(now / 1000),
  }));
  const ringFloor = db.select({ id: pluginLogEntries.id }).from(pluginLogEntries)
    .where(eq(pluginLogEntries.pluginId, pluginId))
    .orderBy(desc(pluginLogEntries.id))
    .limit(1)
    .offset(PLUGIN_LOG_RING_SIZE - 1);
  await safeBatch(db, [
    ...chunkRowsForD1(rows, 7).map((chunk) => db.insert(pluginLogEntries).values(chunk)),
    db.delete(pluginLogEntries).where(and(
      eq(pluginLogEntries.pluginId, pluginId),
      lt(pluginLogEntries.id, ringFloor),
    )),
  ] as never);
  return rows.length;
}

/** Newest first; `before` is the id of the last line already shown. */
export async function listPluginLogs(
  db: Database,
  pluginId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<PluginLogLine[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), PLUGIN_LOG_RING_SIZE);
  const rows = await db.select().from(pluginLogEntries)
    .where(and(
      eq(pluginLogEntries.pluginId, pluginId),
      options.before ? lt(pluginLogEntries.id, options.before) : undefined,
    ))
    .orderBy(desc(pluginLogEntries.id))
    .limit(limit)
    .all();
  return rows.map((row) => ({
    id: row.id,
    level: row.level,
    source: row.source,
    message: row.message,
    fields: JSON.parse(row.fieldsJson) as Record<string, unknown>,
    createdAt: row.createdAt,
  }));
}
