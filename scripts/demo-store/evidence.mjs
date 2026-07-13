import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendResumeRecord } from "./journal.mjs";

function safeStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function writeJson(path, value, { writeFileImpl = writeFile } = {}) {
  await writeFileImpl(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function writeEvidenceBundle({
  baseDir = resolve(".wrangler/demo-store-evidence"), snapshot, diff,
  now = () => new Date(), id = () => randomUUID().slice(0, 8),
  mkdirImpl = mkdir, writeFileImpl = writeFile, appendFileImpl,
}) {
  const timestamp = now();
  const runId = `run-${safeStamp(timestamp)}-${id()}`;
  const runDir = resolve(baseDir, runId);
  await mkdirImpl(runDir, { recursive: true, mode: 0o700 });
  const files = {
    categories: "categories.json",
    products: "products.json",
    productDetails: "product-details.json",
    media: "media.json",
    attributes: "attributes.json",
    collections: "collections.json",
    presentation: "presentation.json",
    diff: "diff.json",
    run: "run.json",
    journal: "resume.jsonl",
  };
  await writeJson(resolve(runDir, files.categories), snapshot.categories, { writeFileImpl });
  await writeJson(resolve(runDir, files.products), snapshot.products, { writeFileImpl });
  await writeJson(resolve(runDir, files.productDetails), snapshot.productDetails, { writeFileImpl });
  await writeJson(resolve(runDir, files.media), snapshot.media, { writeFileImpl });
  await writeJson(resolve(runDir, files.attributes), snapshot.attributes, { writeFileImpl });
  await writeJson(resolve(runDir, files.collections), snapshot.collections, { writeFileImpl });
  await writeJson(resolve(runDir, files.presentation), snapshot.presentation, { writeFileImpl });
  await writeJson(resolve(runDir, files.diff), diff, { writeFileImpl });
  await writeJson(resolve(runDir, files.run), {
    schemaVersion: 1,
    mode: "diff",
    readOnly: true,
    capturedAt: snapshot.capturedAt,
    generatedAt: diff.generatedAt,
    auth: snapshot.auth,
    files,
  }, { writeFileImpl });
  await appendResumeRecord(resolve(runDir, files.journal), {
    schemaVersion: 1,
    mode: "diff",
    phase: "snapshot-current-state",
    resumeKey: "v1:00:snapshot-current-state",
    status: "complete",
    timestamp: timestamp.toISOString(),
    evidenceFile: files.run,
    count: snapshot.products.length,
  }, { appendFileImpl });
  return { runId, runDir, files };
}

