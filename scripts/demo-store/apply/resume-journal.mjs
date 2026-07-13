const SUCCESS_STATUSES = new Set([
  "applied",
  "already_applied",
  "adopted_after_ambiguous_response",
]);

const AUTHORITY_FIELDS = new Set([
  "id",
  "aggregateRevision",
  "revision",
  "version",
  "defaultVariantId",
]);

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/u;

function positiveRevision(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Resume authority ${field} must be a positive integer.`);
  }
  return value;
}

export function sanitizeResumeAuthority(authority) {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
    throw new Error("A successful resume record needs authority.");
  }
  for (const field of Object.keys(authority)) {
    if (!AUTHORITY_FIELDS.has(field)) throw new Error(`Resume authority field is not allowed: ${field}`);
  }
  const result = {};
  for (const field of ["id", "defaultVariantId"]) {
    if (authority[field] === undefined) continue;
    if (typeof authority[field] !== "string" || !SAFE_ID.test(authority[field])) {
      throw new Error(`Resume authority ${field} is invalid.`);
    }
    result[field] = authority[field];
  }
  for (const field of ["aggregateRevision", "revision", "version"]) {
    if (authority[field] !== undefined) result[field] = positiveRevision(authority[field], field);
  }
  if (Object.keys(result).length === 0) throw new Error("A successful resume record has empty authority.");
  return result;
}

export function createResumeRecord({
  intentFingerprint,
  phase,
  logicalKey,
  status,
  authority,
  timestamp = new Date().toISOString(),
}) {
  if (!/^[a-f0-9]{64}$/u.test(intentFingerprint ?? "")) throw new Error("Resume record needs the full intent fingerprint.");
  if (typeof phase !== "string" || !phase || typeof logicalKey !== "string" || !logicalKey) {
    throw new Error("Resume record needs a phase and logical key.");
  }
  if (!SUCCESS_STATUSES.has(status)) throw new Error(`Resume status is not restorable: ${status}`);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Resume record needs an ISO timestamp.");
  return {
    schemaVersion: 2,
    intentFingerprint,
    phase,
    logicalKey,
    status,
    authority: sanitizeResumeAuthority(authority),
    timestamp,
  };
}

function assertMonotonic(previous, next, logicalKey) {
  if (previous.id && next.id && previous.id !== next.id) {
    throw new Error(`Resume authority identity changed for ${logicalKey}.`);
  }
  for (const field of ["aggregateRevision", "revision", "version"]) {
    if (previous[field] !== undefined && next[field] !== undefined && next[field] < previous[field]) {
      throw new Error(`Resume authority ${field} moved backwards for ${logicalKey}.`);
    }
  }
}

export function restoreResumeState(records, intentFingerprint) {
  if (!/^[a-f0-9]{64}$/u.test(intentFingerprint ?? "")) throw new Error("A full intent fingerprint is required to restore resume state.");
  const authorities = new Map();
  const completed = new Set();
  for (const raw of records ?? []) {
    if (raw?.schemaVersion !== 2 || raw.intentFingerprint !== intentFingerprint) {
      throw new Error("Resume journal does not match the authorized demo-store intent.");
    }
    const record = createResumeRecord(raw);
    const previous = authorities.get(record.logicalKey);
    if (previous) assertMonotonic(previous, record.authority, record.logicalKey);
    authorities.set(record.logicalKey, { ...previous, ...record.authority });
    completed.add(record.logicalKey);
  }
  return { authorities, completed };
}

export function parseResumeJournal(text, intentFingerprint) {
  if (typeof text !== "string") throw new Error("Resume journal must be text.");
  const records = text.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Resume journal line ${index + 1} is not valid JSON.`);
    }
  });
  return restoreResumeState(records, intentFingerprint);
}
