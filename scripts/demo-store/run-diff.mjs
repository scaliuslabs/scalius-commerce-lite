import { resolve } from "node:path";
import { demoStoreManifest } from "./manifest.mjs";
import { assertValidDemoStoreManifest } from "./validate.mjs";
import { createAdminReadClient, readAdminSnapshot } from "./api-read.mjs";
import { buildDemoStoreDiff } from "./diff.mjs";
import { writeEvidenceBundle } from "./evidence.mjs";
import { closeAdminSession, openAdminSession } from "./session.mjs";

export async function runDemoStoreDiff({
  adminOrigin,
  evidenceDir = resolve(".wrangler/demo-store-evidence"),
  timeoutMs = 20_000,
  credentials,
  manifest = demoStoreManifest,
  fetchImpl = fetch,
  evidenceWriter = writeEvidenceBundle,
  openSession = openAdminSession,
  closeSession = closeAdminSession,
  readClientFactory = createAdminReadClient,
  snapshotReader = readAdminSnapshot,
  diffBuilder = buildDemoStoreDiff,
}) {
  assertValidDemoStoreManifest(manifest);
  let session;
  let cleanup = { status: "not_started", statusCode: null };
  try {
    session = await openSession({ adminOrigin, ...credentials, fetchImpl, timeoutMs });
    const client = readClientFactory({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs });
    const snapshot = await snapshotReader(client, manifest);
    const diff = diffBuilder(manifest, snapshot);
    const evidence = await evidenceWriter({ baseDir: evidenceDir, snapshot, diff });
    return {
      mode: "diff",
      readOnly: true,
      writesEnabled: false,
      auth: session.evidence,
      diff,
      evidence: { runId: evidence.runId, runDir: evidence.runDir, files: evidence.files },
      get sessionCleanup() { return cleanup; },
    };
  } finally {
    if (session?.cookieHeader) cleanup = await closeSession({ adminOrigin, cookieHeader: session.cookieHeader, fetchImpl, timeoutMs });
  }
}
