// The public app ABI. Snapshot updates require an additive-contract review;
// breaking changes require a new apiVersion, not merely `vitest -u`.
// Stable operation compatibility has its own gate in apps/api/src/openapi.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EVENTS_API_VERSION, EVENT_FACT_SCHEMAS, EVENT_TOPIC_RESOURCE } from "../events";
import { pluginManifestSchema, PLUGIN_API_VERSION } from "./manifest";
import { PLUGIN_FUNCTION_SCHEMAS } from "./functions";
import { PROVIDER_PORTS } from "./providers";
import { PLUGIN_SCOPES } from "./scopes";
import * as protocol from "./storefront-protocol";
import { pluginUiDocumentSchema } from "./ui";

const schema = (value: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(value, { io });
const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** Emit the SDK's actual declarations in memory, without a workspace build/typecheck. */
async function sdkDeclarations(): Promise<string> {
  // Runtime specifiers keep Node types out of this Workers package (assets.test.ts).
  const [{ readFileSync }, { resolve, relative }, { fileURLToPath }] = await Promise.all(
    ["node:fs", "node:path", "node:url"].map((specifier) => import(/* @vite-ignore */ specifier)),
  ) as [
    { readFileSync(path: string, encoding: "utf8"): string },
    { resolve(...paths: string[]): string; relative(from: string, to: string): string },
    { fileURLToPath(url: URL): string },
  ];
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const sdk = resolve(root, "packages/plugin-sdk");
  const pkg = JSON.parse(readFileSync(resolve(sdk, "package.json"), "utf8")) as { exports: Record<string, string>; publishConfig?: { exports: unknown } };
  const sources = Object.values(pkg.exports).map((path) => resolve(sdk, path));
  const protocolFile = resolve(root, "packages/shared/src/plugins/storefront-protocol.ts");
  const program = ts.createProgram([...sources, protocolFile], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true, emitDeclarationOnly: true, noCheck: true, skipLibCheck: true,
    strict: true, removeComments: true, types: [],
  });
  const declarations: Array<[string, string]> = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(`${sdk}/src/`) && source.fileName !== protocolFile) continue;
    const result = program.emit(source, (path, output) => {
      if (path.endsWith(".d.ts")) declarations.push([relative(root, path), output]);
    });
    expect(result.emitSkipped, source.fileName).toBe(false);
    expect(result.diagnostics, source.fileName).toEqual([]);
  }
  expect(declarations.length).toBeGreaterThanOrEqual(sources.length);
  return `// Public exports\n${json({ exports: pkg.exports, publishExports: pkg.publishConfig?.exports })}\n` + declarations.sort(([a], [b]) => a.localeCompare(b)).map(([path, output]) => `// ${path}\n${output}`).join("\n");
}

describe("the versioned plugin ABI", () => {
  it("seals the strict manifest JSON Schema", async () => {
    await expect(json({ apiVersion: PLUGIN_API_VERSION, schema: schema(pluginManifestSchema) }))
      .toMatchFileSnapshot("./abi.manifest.snapshot.json");
  });

  it("seals functions, provider ports, UI, scopes, events and storefront protocol constants", async () => {
    const port = (value: { input: z.ZodType; output: z.ZodType }) => ({ input: schema(value.input), output: schema(value.output, "output") });
    await expect(json({
      apiVersion: PLUGIN_API_VERSION,
      functions: Object.fromEntries(Object.entries(PLUGIN_FUNCTION_SCHEMAS).map(([name, value]) => [name, port(value)])),
      providers: Object.fromEntries(Object.entries(PROVIDER_PORTS).map(([name, operations]) => [name,
        Object.fromEntries(Object.entries(operations).map(([operation, value]) => [operation, port(value)])),
      ])),
      adminUi: schema(pluginUiDocumentSchema), scopes: PLUGIN_SCOPES,
      events: { apiVersion: EVENTS_API_VERSION, resources: EVENT_TOPIC_RESOURCE,
        facts: Object.fromEntries(Object.entries(EVENT_FACT_SCHEMAS).map(([topic, value]) => [topic, schema(value, "output")])),
      },
      storefront: Object.fromEntries(Object.entries(protocol).filter(([name, value]) => name === name.toUpperCase() && typeof value !== "function")
        .map(([name, value]) => [name, value instanceof RegExp ? value.source : value])),
    })).toMatchFileSnapshot("./abi.protocol.snapshot.json");
  });

  it("seals the SDK export map and emitted public declarations", async () => {
    await expect(await sdkDeclarations()).toMatchFileSnapshot("./abi.sdk.snapshot.txt");
  }, 30_000);
});
