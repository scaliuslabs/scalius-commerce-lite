import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const evidencePath = resolve(root, "docs/research/agent-live-operation-evidence.json");
const manifestPath = resolve(root, "apps/api/src/generated/agent-operations.gen.ts");

const [evidenceText, manifestSource] = await Promise.all([
  readFile(evidencePath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
const evidence = JSON.parse(evidenceText);
const manifestStart = manifestSource.indexOf("= [") + 2;
const manifestEnd = manifestSource.indexOf("\n];", manifestStart) + 2;
if (manifestStart < 2 || manifestEnd < 2) throw new Error("Generated agent manifest array was not found.");
const manifest = JSON.parse(manifestSource.slice(manifestStart, manifestEnd));
const operationsById = new Map(manifest.map((operation) => [operation.operationId, operation]));
const fields = ["surface", "exposure", "risk", "method", "pathTemplate"];
const errors = [];

if (evidence.contractCount !== manifest.length) {
  errors.push(`contractCount ${evidence.contractCount} != generated ${manifest.length}`);
}
if (evidence.operations.length !== manifest.length) {
  errors.push(`evidence rows ${evidence.operations.length} != generated ${manifest.length}`);
}
for (const row of evidence.operations) {
  const operation = operationsById.get(row.operationId);
  if (!operation) {
    errors.push(`${row.operationId}: absent from generated manifest`);
    continue;
  }
  operationsById.delete(row.operationId);
  for (const field of fields) {
    if (row[field] !== operation[field]) {
      errors.push(`${row.operationId}.${field}: evidence=${JSON.stringify(row[field])} generated=${JSON.stringify(operation[field])}`);
    }
  }
  if (operation.exposure === "excluded") {
    for (const surface of ["cli", "mcp"]) {
      if (row[surface]?.state !== "not_applicable") {
        errors.push(`${row.operationId}.${surface}.state must be not_applicable for excluded operations`);
      }
    }
  }
}
for (const operationId of operationsById.keys()) errors.push(`${operationId}: missing evidence row`);

if (errors.length > 0) {
  console.error(`Agent live evidence drift (${errors.length}):\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Agent live evidence matches ${manifest.length} generated operations.`);
}
