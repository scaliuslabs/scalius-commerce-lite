import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentOperationManifest,
  renderAgentOperationManifestModule,
  type AgentOperationManifestEntry,
  type AgentOperationOpenApiDocument,
} from "./agent-operation-manifest";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const apiSourceDirectory = resolve(currentDirectory, "..");
export const AGENT_OPERATION_MANIFEST_PATH = resolve(
  apiSourceDirectory,
  "generated/agent-operations.gen.ts",
);

const GENERIC_PENDING_REASON_PATTERNS = [
  /\bpending\b.*\b(?:parity|review|classification|authority)\b/i,
  /\b(?:parity|review|classification|authority)\b.*\bpending\b/i,
  /\b(?:unreviewed|not yet reviewed|awaiting review)\b/i,
  /\brequires explicit reviewed agent metadata before exposure\b/i,
] as const;

export function assertNoGenericPendingAgentOperations(
  manifest: readonly AgentOperationManifestEntry[],
): void {
  const pending = manifest.filter((operation) =>
    operation.exposure === "excluded" &&
    GENERIC_PENDING_REASON_PATTERNS.some((pattern) =>
      pattern.test(operation.exclusionReason ?? ""),
    )
  );
  if (pending.length > 0) {
    throw new Error(
      `Agent operation manifest has ${pending.length} generic pending classifications: ${pending
        .map((operation) => operation.operationId)
        .sort()
        .join(", ")}.`,
    );
  }
}

export function generateAgentOperationManifestSource(
  document: AgentOperationOpenApiDocument,
): string {
  const manifest = buildAgentOperationManifest(document);
  assertNoGenericPendingAgentOperations(manifest);
  return renderAgentOperationManifestModule(manifest);
}

export function writeAgentOperationManifest(
  document: AgentOperationOpenApiDocument,
): string {
  const source = generateAgentOperationManifestSource(document);
  mkdirSync(dirname(AGENT_OPERATION_MANIFEST_PATH), { recursive: true });
  writeFileSync(AGENT_OPERATION_MANIFEST_PATH, source);
  return source;
}

export function assertAgentOperationManifestFresh(
  document: AgentOperationOpenApiDocument,
): void {
  const expected = generateAgentOperationManifestSource(document);
  let actual: string;
  try {
    actual = readFileSync(AGENT_OPERATION_MANIFEST_PATH, "utf8");
  } catch {
    throw new Error(
      `Generated agent operation manifest is missing at ${AGENT_OPERATION_MANIFEST_PATH}.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      "Generated agent operation manifest is stale. Regenerate it from the finalized OpenAPI contract.",
    );
  }
}
