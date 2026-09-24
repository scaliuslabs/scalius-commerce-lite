import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMPONENT_SCHEMAS,
  AGENT_OPERATIONS,
} from "../generated/agent-operations.gen";
import { describeOperation, isMcpOperationExposure } from "../agent-access/mcp/operations";
import {
  buildAgentComponentSchemas,
  buildAgentOperationManifest,
  renderAgentOperationManifestModule,
  type AgentOperationOpenApiDocument,
} from "./agent-operation-manifest";
import { AGENT_OPERATION_MANIFEST_PATH } from "./generate-agent-operation-manifest";
import {
  COMPONENT_SCHEMA_REF_PREFIX,
  componentSchemaRefName,
  referencedComponentSchemas,
  resolveComponentSchemaRef,
} from "./component-schema-refs";

/** Every `$ref` in a value. */
function refs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => refs(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.$ref === "string") found.push(record.$ref);
    Object.values(record).forEach((child) => refs(child, found));
  }
  return found;
}

function resolvesIn(root: unknown, ref: string): boolean {
  if (!ref.startsWith("#/")) return false;
  let current = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

const reviewed = {
  surface: "dashboard",
  exposure: "execute",
  principals: ["admin"],
  risk: "read",
  openWorld: false,
  idempotency: "none",
  revision: "none",
  batch: "parallel",
  transport: "json",
  maximumResponseBytes: 65_536,
  maxRequestBytes: 1_048_576,
  sensitiveOutput: false,
  oneTimeSecretOutput: false,
};

function operation(operationId: string, schema: unknown) {
  return {
    operationId,
    summary: operationId,
    "x-scalius-agent": reviewed,
    "x-scalius-rbac": { type: "permission", permission: "settings.general.view" },
    responses: { 200: { content: { "application/json": { schema } } } },
  };
}

describe("shared component schemas in the agent manifest", () => {
  it("keeps references, emits each shared schema once, and rejects a dangling reference", () => {
    const document: AgentOperationOpenApiDocument = {
      paths: {
        "/a": { get: operation("dashboard.fixture.read_a", { $ref: "#/components/schemas/Theme" }) },
        "/b": { get: operation("dashboard.fixture.read_b", { type: "object", properties: { theme: { $ref: "#/components/schemas/Theme" } } }) },
      },
      components: {
        schemas: {
          Theme: { type: "object", properties: { layout: { $ref: "#/components/schemas/Layout" } } },
          Layout: { type: "string" },
          Unused: { type: "number" },
        },
      },
    };
    const manifest = buildAgentOperationManifest(document);
    expect(manifest.map((entry) => entry.outputSchema)).toEqual([
      { $ref: "#/components/schemas/Theme" },
      { type: "object", properties: { theme: { $ref: "#/components/schemas/Theme" } } },
    ]);
    // Referenced components (and the ones they refer to) are emitted once; unused ones are not.
    const components = buildAgentComponentSchemas(document, manifest);
    expect(Object.keys(components)).toEqual(["Layout", "Theme"]);
    const source = renderAgentOperationManifestModule(manifest, { version: "3.0.0" } as never, components);
    expect(source.match(/"layout":/g)).toHaveLength(1);

    const dangling = structuredClone(document);
    delete (dangling.components!.schemas as Record<string, unknown>).Layout;
    expect(() => buildAgentOperationManifest(dangling)).toThrowError(/Unknown OpenAPI component schema #\/components\/schemas\/Layout/);
  });

  it("resolves references shallowly and keeps sibling keywords", () => {
    const schemas = { Name: { type: "string", maxLength: 80 }, Alias: { $ref: "#/components/schemas/Name" } };
    // Chains are followed, and the sibling keywords of each reference stay.
    expect(resolveComponentSchemaRef({ $ref: "#/components/schemas/Alias", description: "Shown name" }, schemas))
      .toEqual({ type: "string", maxLength: 80, description: "Shown name" });
    expect(resolveComponentSchemaRef({ $ref: "#/components/schemas/Name" }, schemas)).toEqual({ type: "string", maxLength: 80 });
    // An unknown component stays an opaque node for walkers.
    expect(resolveComponentSchemaRef({ $ref: "#/components/schemas/Missing" }, schemas)).toEqual({ $ref: "#/components/schemas/Missing" });
    expect(componentSchemaRefName({ $ref: "#/paths/~1a" })).toBeNull();
  });

  it("every reference in the generated manifest resolves, and no shared schema is repeated", () => {
    const root = { components: { schemas: AGENT_COMPONENT_SCHEMAS } };
    const all = refs([AGENT_OPERATIONS, AGENT_COMPONENT_SCHEMAS]);
    expect(all.length).toBeGreaterThan(0);
    for (const ref of all) {
      expect(ref.startsWith(COMPONENT_SCHEMA_REF_PREFIX), ref).toBe(true);
      expect(resolvesIn(root, ref), ref).toBe(true);
    }
    // Exactly the components the operations use, transitively.
    expect(Object.keys(AGENT_COMPONENT_SCHEMAS)).toEqual(Object.keys(referencedComponentSchemas(
      AGENT_OPERATIONS.map((entry) => [entry.inputSchema, entry.outputSchema]),
      AGENT_COMPONENT_SCHEMAS,
    )));
    expect(AGENT_COMPONENT_SCHEMAS).toHaveProperty("StorefrontThemeDocument");
    // The theme document is written once, not per operation.
    const source = readFileSync(AGENT_OPERATION_MANIFEST_PATH, "utf8");
    expect(source.split('"template":{"type":"string","enum":["boutique"').length - 1).toBe(1);
    // Compact JSON: no indented value lines.
    expect(source).not.toMatch(/\n {2}"/);
  });

  it("gives every full MCP description the shared schemas its references need", () => {
    const described = AGENT_OPERATIONS.filter(isMcpOperationExposure).map((entry) => describeOperation(entry, true));
    const withShared = described.filter((description) => "components" in description);
    expect(withShared.length).toBeGreaterThan(0);
    for (const description of described) {
      for (const ref of refs([description.inputSchema, description.outputSchema, (description as { components?: unknown }).components])) {
        expect(resolvesIn(description, ref), `${description.operationId} ${ref}`).toBe(true);
      }
    }
  });
});
