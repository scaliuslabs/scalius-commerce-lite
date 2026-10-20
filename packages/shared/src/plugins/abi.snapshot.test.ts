// The public app ABI. Each sealed snapshot is first compared with the
// committed one under the breaking-change rules (`abi-compat.ts`); only then
// is it written, so `vitest -u` accepts an additive change and never a
// breaking one. A break needs an entry in `abi.breaks.json` (the failure
// prints it, with the committed snapshot's fingerprint, ready for a reason),
// or a new apiVersion. Stable operations have their own gate in
// apps/api/src/openapi.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EVENTS_API_VERSION, EVENT_FACT_SCHEMAS, EVENT_TOPIC_RESOURCE } from "../events";
import {
  manifestBreakingChanges,
  protocolBreakingChanges,
  snapshotFingerprint,
  unacknowledgedBreaks,
  type AbiBreakAcknowledgement,
} from "./abi-compat";
import acknowledgements from "./abi.breaks.json";
import { pluginManifestSchema, PLUGIN_API_VERSION } from "./manifest";
import { PLUGIN_FUNCTION_SCHEMAS } from "./functions";
import { PROVIDER_PORTS } from "./providers";
import { PROVIDER_PORT_TIERS, type ProviderKind } from "./providers/kinds";
import { PLUGIN_SCOPES } from "./scopes";
import * as protocol from "./storefront-protocol";
import { PLUGIN_UI_SURFACES, pluginUiDocumentSchema } from "./ui";

const schema = (value: z.ZodType, io: "input" | "output" = "input") => z.toJSONSchema(value, { io });
const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;
const port = (value: { input: z.ZodType; output: z.ZodType }) => ({ input: schema(value.input), output: schema(value.output, "output") });
/** The ports of one tier with their operations' schemas. */
const portsOfTier = (tier: "stable" | "beta") => Object.fromEntries(Object.entries(PROVIDER_PORTS)
  .filter(([kind]) => PROVIDER_PORT_TIERS[kind as ProviderKind] === tier)
  .map(([name, operations]) => [name,
    Object.fromEntries(Object.entries(operations).map(([operation, value]) => [operation, port(value)])),
  ]));

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

/** The committed snapshot's text, or null before the first one is written. */
async function committedText(file: string): Promise<string | null> {
  // A runtime specifier keeps Node types out of this Workers package (as in sdkDeclarations).
  const [{ readFileSync }] = await Promise.all(["node:fs"].map((specifier) => import(/* @vite-ignore */ specifier))) as [
    { readFileSync(path: URL, encoding: "utf8"): string },
  ];
  try {
    return readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    return null;
  }
}

/**
 * Refuses an unacknowledged break from the committed snapshot, then seals the
 * current one. Both happen in one test so `-u` cannot write past a refusal.
 */
async function sealCompatibly(file: string, current: unknown, breakingChanges: (before: unknown, after: unknown) => string[]): Promise<void> {
  const text = json(current);
  const committed = await committedText(file);
  if (committed !== null && committed !== text) {
    const open = unacknowledgedBreaks(file, await snapshotFingerprint(committed), breakingChanges(JSON.parse(committed), current),
      acknowledgements as AbiBreakAcknowledgement[]);
    expect(open, `Breaking ABI changes in ${file}. Keep the old shape, or add these entries with a reason to abi.breaks.json.`).toEqual([]);
  }
  await expect(text).toMatchFileSnapshot(file);
}

describe("the versioned plugin ABI", () => {
  it("seals the strict manifest JSON Schema", async () => {
    await sealCompatibly("./abi.manifest.snapshot.json", { apiVersion: PLUGIN_API_VERSION, schema: schema(pluginManifestSchema) }, manifestBreakingChanges);
  });

  it("seals functions, stable provider ports, UI, scopes, events and storefront protocol constants", async () => {
    await sealCompatibly("./abi.protocol.snapshot.json", {
      apiVersion: PLUGIN_API_VERSION,
      functions: Object.fromEntries(Object.entries(PLUGIN_FUNCTION_SCHEMAS).map(([name, value]) => [name, port(value)])),
      providerTiers: PROVIDER_PORT_TIERS,
      providers: portsOfTier("stable"),
      ui: { document: schema(pluginUiDocumentSchema("admin")), surfaces: PLUGIN_UI_SURFACES }, scopes: PLUGIN_SCOPES,
      events: { apiVersion: EVENTS_API_VERSION, resources: EVENT_TOPIC_RESOURCE,
        facts: Object.fromEntries(Object.entries(EVENT_FACT_SCHEMAS).map(([topic, value]) => [topic, schema(value, "output")])),
      },
      storefront: Object.fromEntries(Object.entries(protocol).filter(([name, value]) => name === name.toUpperCase() && typeof value !== "function")
        .map(([name, value]) => [name, value instanceof RegExp ? value.source : value])),
    }, protocolBreakingChanges);
  });

  it("keeps beta provider ports outside the seal, in a reviewed snapshot of their own", async () => {
    await expect(json({ apiVersion: PLUGIN_API_VERSION, providers: portsOfTier("beta") }))
      .toMatchFileSnapshot("./abi.beta.snapshot.json");
  });

  it("seals the SDK export map and emitted public declarations", async () => {
    await expect(await sdkDeclarations()).toMatchFileSnapshot("./abi.sdk.snapshot.txt");
  }, 30_000);
});
