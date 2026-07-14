import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_JOURNAL_LINES = 20_000;
const MAX_LOGICAL_KEY_LENGTH = 200;
const MAX_PART_NUMBER = 20;
const ALLOWED_FIELDS = new Set([
  "schemaVersion", "runFingerprint", "logicalKey", "action", "status", "timestamp",
  "sessionId", "mediaId", "partNumber", "posterMediaId",
]);
const ACTIONS = new Set(["upload", "uploaded", "reuse", "adopted", "resumed", "poster"]);
const STATUSES = new Set(["session", "part", "ready", "retained-reuse", "adopted", "poster-linked"]);
const ACTIONS_BY_STATUS = new Map([
  ["session", new Set(["upload"])],
  ["part", new Set(["upload"])],
  ["ready", new Set(["uploaded"])],
  ["retained-reuse", new Set(["reuse"])],
  ["adopted", new Set(["adopted", "resumed"])],
  ["poster-linked", new Set(["poster"])],
]);
const REQUIRED_FIELDS_BY_STATUS = new Map([
  ["session", new Set(["sessionId", "mediaId"])],
  ["part", new Set(["sessionId", "mediaId", "partNumber"])],
  ["ready", new Set(["sessionId", "mediaId"])],
  ["retained-reuse", new Set(["mediaId"])],
  ["adopted", new Set(["mediaId"])],
  ["poster-linked", new Set(["mediaId", "posterMediaId"])],
]);
const STATUS_FIELDS = new Set(["sessionId", "mediaId", "partNumber", "posterMediaId"]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/iu;
const LOGICAL_KEY_PATTERN = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?::[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/u;
const UNSAFE_LOGICAL_KEY_PATTERN = /cookie|bearer|password|secret|otp|proof|@/iu;
const MEDIA_ID_PATTERN = /^media_[A-Za-z0-9_-]{21}$/u;
const SESSION_ID_PATTERN = /^mup_[A-Za-z0-9_-]{21}$/u;

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string" || value.length > 40 || /[\r\n]/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateLogicalKey(value) {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > MAX_LOGICAL_KEY_LENGTH
    || /[\r\n]/u.test(value)
    || UNSAFE_LOGICAL_KEY_PATTERN.test(value)
    || !LOGICAL_KEY_PATTERN.test(value)
  ) {
    throw new Error("Media upload journal logical key is invalid or unsafe.");
  }
}

function validateOpaqueId(field, value) {
  const pattern = field === "sessionId" ? SESSION_ID_PATTERN : MEDIA_ID_PATTERN;
  if (typeof value !== "string" || /[\r\n]/u.test(value) || !pattern.test(value)) {
    throw new Error(`Media upload journal ${field} is invalid.`);
  }
}

function validateRecord(record, fingerprint) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Media upload journal record must be an object.");
  for (const field of Object.keys(record)) if (!ALLOWED_FIELDS.has(field)) throw new Error(`Media upload journal field is not allowed: ${field}.`);
  if (
    record.schemaVersion !== 1
    || typeof fingerprint !== "string"
    || !FINGERPRINT_PATTERN.test(fingerprint)
    || record.runFingerprint !== fingerprint
  ) throw new Error("Media upload journal fingerprint does not match this run.");
  validateLogicalKey(record.logicalKey);
  if (!isCanonicalIsoTimestamp(record.timestamp) || !STATUSES.has(record.status) || !ACTIONS.has(record.action)) {
    throw new Error("Media upload journal record is incomplete.");
  }
  if (!ACTIONS_BY_STATUS.get(record.status)?.has(record.action)) {
    throw new Error("Media upload journal action does not match its status.");
  }
  const requiredFields = REQUIRED_FIELDS_BY_STATUS.get(record.status);
  for (const field of STATUS_FIELDS) {
    const present = Object.hasOwn(record, field);
    if (requiredFields.has(field) !== present) {
      throw new Error(`Media upload journal ${record.status} record has invalid fields.`);
    }
  }
  if (Object.hasOwn(record, "sessionId")) validateOpaqueId("sessionId", record.sessionId);
  if (Object.hasOwn(record, "mediaId")) validateOpaqueId("mediaId", record.mediaId);
  if (Object.hasOwn(record, "posterMediaId")) validateOpaqueId("posterMediaId", record.posterMediaId);
  if (Object.hasOwn(record, "partNumber") && (!Number.isSafeInteger(record.partNumber) || record.partNumber < 1 || record.partNumber > MAX_PART_NUMBER)) {
    throw new Error("Media upload journal part number is invalid.");
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
