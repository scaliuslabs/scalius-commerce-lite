const ALLOWED_FIELDS = new Set([
  "schemaVersion", "mode", "phase", "resumeKey", "logicalKey", "resourceId",
  "oldRevision", "newRevision", "status", "timestamp", "evidenceFile", "count",
]);

export function sanitizeResumeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Resume record must be an object.");
  for (const key of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`Resume journal field is not allowed: ${key}`);
  }
  if (!record.timestamp || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("Resume record needs an ISO timestamp.");
  if (!record.status || typeof record.status !== "string") throw new Error("Resume record needs a status.");
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (value.length > 500 || /[\r\n]/.test(value) || /cookie|bearer|password|secret|otp|proof/i.test(value) || value.includes("@")) {
      throw new Error(`Resume journal value is not safe for ${key}.`);
    }
  }
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export async function appendResumeRecord(path, record, { appendFileImpl } = {}) {
  const append = appendFileImpl ?? (await import("node:fs/promises")).appendFile;
  const safe = sanitizeResumeRecord(record);
  await append(path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  return safe;
}
