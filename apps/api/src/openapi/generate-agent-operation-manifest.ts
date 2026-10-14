import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_OPERATION_MANIFEST_LOADER_SOURCE,
  buildAgentComponentSchemas,
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
// The large payloads are Text modules (strings workerd does not compile at
// isolate start); each has a small generated loader beside it.
export const AGENT_OPERATION_MANIFEST_PATH = resolve(
  apiSourceDirectory,
  "generated/agent-operations.gen.txt",
);
export const AGENT_OPERATION_MANIFEST_LOADER_PATH = resolve(
  apiSourceDirectory,
  "generated/agent-operations.gen.ts",
);
export const OPENAPI_CONTRACT_TEXT_PATH = resolve(
  apiSourceDirectory,
  "generated/openapi-contract.gen.txt",
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
// The published CLI carries no workspace dependency, so it gets a verbatim copy
// of the rendition ladder: the API accepts renditions only at the widths
// `mediaVariantWidths()` derives, and the CLI encodes them locally.
export const MEDIA_VARIANTS_SOURCE_PATH = resolve(
  apiSourceDirectory,
  "../../../packages/shared/src/media-variants.ts",
);
export const CLI_MEDIA_VARIANTS_PATH = resolve(
  apiSourceDirectory,
  "../../../packages/cli/src/generated/media-variants.gen.ts",
);
const CLI_MEDIA_VARIANTS_HEADER =
  "// Generated from packages/shared/src/media-variants.ts.\n// Do not edit by hand.\n\n";
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
  const componentSchemas = buildAgentComponentSchemas(document, manifest);
  const workflowCatalog = buildAgentWorkflowCatalog(manifest, {
    requireCuratedCards: true,
    componentSchemas,
  });
  assertAgentWorkflowExtension(
    document["x-scalius-workflows"],
    workflowCatalog,
  );
  return renderAgentOperationManifestModule(manifest, workflowCatalog, componentSchemas);
}

export function writeAgentOperationManifest(
  document: AgentOperationOpenApiDocument,
): string {
  const source = generateAgentOperationManifestSource(document);
  mkdirSync(dirname(AGENT_OPERATION_MANIFEST_PATH), { recursive: true });
  writeFileSync(AGENT_OPERATION_MANIFEST_PATH, source);
  writeFileSync(AGENT_OPERATION_MANIFEST_LOADER_PATH, AGENT_OPERATION_MANIFEST_LOADER_SOURCE);
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

export function generateCliMediaVariantsSource(): string {
  return `${CLI_MEDIA_VARIANTS_HEADER}${readFileSync(MEDIA_VARIANTS_SOURCE_PATH, "utf8")}`;
}

export function writeCliMediaVariants(): string {
  const source = generateCliMediaVariantsSource();
  mkdirSync(dirname(CLI_MEDIA_VARIANTS_PATH), { recursive: true });
  writeFileSync(CLI_MEDIA_VARIANTS_PATH, source);
  return source;
}

export function assertCliMediaVariantsFresh(): void {
  assertFileContent(CLI_MEDIA_VARIANTS_PATH, generateCliMediaVariantsSource(), "CLI rendition ladder");
}

/** The contract served at /api/v1/openapi.json: its Text module and the loader with its ETag. */
export function generateOpenApiContractModuleSource(
  document: AgentOperationOpenApiDocument,
): { text: string; module: string } {
  const json = JSON.stringify(document);
  const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
  return {
    text: json,
    module: `// This file is generated from the finalized /api/v1 OpenAPI contract.\n// Do not edit by hand.\n\n// A Text module: a string, not compiled at isolate start.\nimport contract from "./openapi-contract.gen.txt";\n\nexport const OPENAPI_CONTRACT_JSON: string = contract;\nexport const OPENAPI_CONTRACT_ETAG = ${JSON.stringify(etag)};\n`,
  };
}

export function writeOpenApiContractModule(
  document: AgentOperationOpenApiDocument,
): void {
  const { text, module } = generateOpenApiContractModuleSource(document);
  mkdirSync(dirname(OPENAPI_CONTRACT_MODULE_PATH), { recursive: true });
  writeFileSync(OPENAPI_CONTRACT_TEXT_PATH, text);
  writeFileSync(OPENAPI_CONTRACT_MODULE_PATH, module);
}

function assertFileContent(path: string, expected: string, what: string): void {
  let actual: string;
  try {
    actual = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Generated ${what} is missing at ${path}.`);
  }
  if (actual !== expected) {
    throw new Error(`Generated ${what} is stale. Regenerate it from the finalized OpenAPI contract.`);
  }
}

export function assertOpenApiContractModuleFresh(
  document: AgentOperationOpenApiDocument,
): void {
  const { text, module } = generateOpenApiContractModuleSource(document);
  assertFileContent(OPENAPI_CONTRACT_TEXT_PATH, text, "OpenAPI contract");
  assertFileContent(OPENAPI_CONTRACT_MODULE_PATH, module, "OpenAPI contract module");
}

export function assertAgentOperationManifestLoaderFresh(): void {
  assertFileContent(AGENT_OPERATION_MANIFEST_LOADER_PATH, AGENT_OPERATION_MANIFEST_LOADER_SOURCE, "agent operation manifest loader");
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
