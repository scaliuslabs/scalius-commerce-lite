import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentOperationManifest,
  renderAgentOperationManifestModule,
  type AgentOperationManifestEntry,
  type AgentOperationOpenApiDocument,
} from "./agent-operation-manifest";
import {
  assertAgentWorkflowExtension,
  buildAgentWorkflowCatalog,
} from "../agent-access/workflows";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const apiSourceDirectory = resolve(currentDirectory, "..");
export const AGENT_OPERATION_MANIFEST_PATH = resolve(
  apiSourceDirectory,
  "generated/agent-operations.gen.ts",
);
export const OPENAPI_CONTRACT_MODULE_PATH = resolve(
  apiSourceDirectory,
  "generated/openapi-contract.gen.ts",
);
export const WORKFLOW_RESOLVER_CORE_SOURCE_PATH = resolve(
  apiSourceDirectory,
  "agent-access/workflows/resolver-core.ts",
);
export const CLI_WORKFLOW_RESOLVER_CORE_PATH = resolve(
  apiSourceDirectory,
  "../../../packages/cli/src/generated/workflow-resolver-core.gen.ts",
);
const CLI_WORKFLOW_RESOLVER_HEADER =
  "// Generated from apps/api/src/agent-access/workflows/resolver-core.ts.\n// Do not edit by hand.\n\n";

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
  const workflowCatalog = buildAgentWorkflowCatalog(manifest, {
    requireCuratedCards: true,
  });
  assertAgentWorkflowExtension(
    document["x-scalius-workflows"],
    workflowCatalog,
  );
  return renderAgentOperationManifestModule(manifest, workflowCatalog);
}

export function writeAgentOperationManifest(
  document: AgentOperationOpenApiDocument,
): string {
  const source = generateAgentOperationManifestSource(document);
  mkdirSync(dirname(AGENT_OPERATION_MANIFEST_PATH), { recursive: true });
  writeFileSync(AGENT_OPERATION_MANIFEST_PATH, source);
  return source;
}

export function generateCliWorkflowResolverCoreSource(): string {
  return `${CLI_WORKFLOW_RESOLVER_HEADER}${readFileSync(WORKFLOW_RESOLVER_CORE_SOURCE_PATH, "utf8")}`;
}

export function writeCliWorkflowResolverCore(): string {
  const source = generateCliWorkflowResolverCoreSource();
  mkdirSync(dirname(CLI_WORKFLOW_RESOLVER_CORE_PATH), { recursive: true });
  writeFileSync(CLI_WORKFLOW_RESOLVER_CORE_PATH, source);
  return source;
}

export function generateOpenApiContractModuleSource(
  document: AgentOperationOpenApiDocument,
): string {
  const json = JSON.stringify(document);
  const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
  return `// This file is generated from the finalized /api/v1 OpenAPI contract.\n// Do not edit by hand.\n\nexport const OPENAPI_CONTRACT_JSON = ${JSON.stringify(json)};\nexport const OPENAPI_CONTRACT_ETAG = ${JSON.stringify(etag)};\n`;
}

export function writeOpenApiContractModule(
  document: AgentOperationOpenApiDocument,
): string {
  const source = generateOpenApiContractModuleSource(document);
  mkdirSync(dirname(OPENAPI_CONTRACT_MODULE_PATH), { recursive: true });
  writeFileSync(OPENAPI_CONTRACT_MODULE_PATH, source);
  return source;
}

export function assertOpenApiContractModuleFresh(
  document: AgentOperationOpenApiDocument,
): void {
  const expected = generateOpenApiContractModuleSource(document);
  let actual: string;
  try {
    actual = readFileSync(OPENAPI_CONTRACT_MODULE_PATH, "utf8");
  } catch {
    throw new Error(
      `Generated OpenAPI contract module is missing at ${OPENAPI_CONTRACT_MODULE_PATH}.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      "Generated OpenAPI contract module is stale. Regenerate it from the finalized OpenAPI contract.",
    );
  }
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

export function assertCliWorkflowResolverCoreFresh(): void {
  const expected = generateCliWorkflowResolverCoreSource();
  let actual: string;
  try {
    actual = readFileSync(CLI_WORKFLOW_RESOLVER_CORE_PATH, "utf8");
  } catch {
    throw new Error(
      `Generated CLI workflow resolver is missing at ${CLI_WORKFLOW_RESOLVER_CORE_PATH}.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      "Generated CLI workflow resolver is stale. Regenerate the agent contract.",
    );
  }
}
