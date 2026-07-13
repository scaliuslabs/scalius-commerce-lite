import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_JOURNAL_LINES = 20_000;
const ALLOWED_FIELDS = new Set([
  "schemaVersion", "runFingerprint", "logicalKey", "action", "status", "timestamp",
  "sessionId", "mediaId", "partNumber", "posterMediaId",
]);
const STATUSES = new Set(["session", "part", "ready", "retained-reuse", "adopted", "poster-linked"]);

function validateRecord(record, fingerprint) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Media upload journal record must be an object.");
  for (const field of Object.keys(record)) if (!ALLOWED_FIELDS.has(field)) throw new Error(`Media upload journal field is not allowed: ${field}.`);
  if (record.schemaVersion !== 1 || record.runFingerprint !== fingerprint) throw new Error("Media upload journal fingerprint does not match this run.");
  if (!record.logicalKey || !record.timestamp || !Number.isFinite(Date.parse(record.timestamp)) || !STATUSES.has(record.status)) {
    throw new Error("Media upload journal record is incomplete.");
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && (value.length > 500 || /[\r\n]/u.test(value) || /cookie|bearer|password|secret|otp|proof|@/iu.test(value))) {
      throw new Error("Media upload journal contains unsafe text.");
    }
  }
  return record;
}

export async function readUploadJournal(journalPath, fingerprint) {
  let text;
  try {
    const info = await stat(journalPath);
    if (info.size > MAX_JOURNAL_BYTES) throw new Error("Media upload journal exceeds its size bound.");
    text = await readFile(journalPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > MAX_JOURNAL_LINES) throw new Error("Media upload journal exceeds its line bound.");
  const state = new Map();
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error("Media upload journal contains invalid JSON."); }
    validateRecord(record, fingerprint);
    const current = state.get(record.logicalKey) ?? { uploadedParts: new Set() };
    if (record.sessionId) current.sessionId = record.sessionId;
    if (record.mediaId) current.mediaId = record.mediaId;
    if (record.partNumber) current.uploadedParts.add(record.partNumber);
    current.status = record.status;
    state.set(record.logicalKey, current);
  }
  return state;
}

export async function appendUploadJournal(journalPath, record, fingerprint) {
  const safe = validateRecord({ schemaVersion: 1, runFingerprint: fingerprint, ...record }, fingerprint);
  await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
  const handle = await open(journalPath, "a", 0o600);
  try {
    await chmod(journalPath, 0o600);
    await handle.write(`${JSON.stringify(safe)}\n`);
  } finally { await handle.close(); }
  return safe;
}
