import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(__dirname, "../../..");

type OpenApiDocument = {
  paths?: Record<string, unknown>;
  [key: string]: unknown;
};

async function generateSpec() {
  // Strategy 1: Try importing the Hono app directly (works when all deps resolve)
  try {
    const appPath = resolve(monorepoRoot, "apps/api/src/app");
    const { default: app } = await import(appPath);
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: {
        title: "Scalius Commerce API",
        version: "1.0.0",
        description:
          "E-commerce platform API powering admin dashboard and storefront",
      },
      servers: [{ url: "/", description: "Default" }],
    });
    writeSpec(spec);
    return;
  } catch (e) {
    console.warn("Direct import failed, trying live server fetch...");
    console.warn(String(e));
  }

  // Strategy 2: Fetch from a running dev server
  try {
    const response = await fetch("http://localhost:8787/api/v1/openapi.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const spec = await response.json();
    writeSpec(spec);
    return;
  } catch (e) {
    console.warn("Live server fetch failed:", String(e));
  }

  console.error(
    "\nCould not generate OpenAPI spec. Either:\n" +
      "  1. Start the API server: pnpm dev --filter=@scalius/api\n" +
      "  2. Then re-run: pnpm generate:spec\n",
  );
  process.exit(1);
}

function writeSpec(spec: OpenApiDocument) {
  removeLocalOnlyRoutes(spec);
  normalizeNullableAnyOf(spec);
  const outputPath = resolve(__dirname, "../openapi.json");
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));
  console.log(`OpenAPI spec written to ${outputPath}`);
  console.log(`Routes documented: ${Object.keys(spec.paths || {}).length}`);
}

function removeLocalOnlyRoutes(spec: OpenApiDocument) {
  if (!spec || typeof spec !== "object" || !spec.paths) return;

  // The local API worker mounts an R2 media passthrough only in development so
  // storefront images can use localhost. Production serves media through the CDN.
  delete spec.paths["/api/v1/media/{key}"];
}

function normalizeNullableAnyOf(value: unknown): void {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) normalizeNullableAnyOf(item);
    return;
  }

  const schema = value as Record<string, unknown>;
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;

    const nullableOnlyIndex = variants.findIndex((variant) => {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
        return false;
      }
      const entries = Object.entries(variant as Record<string, unknown>);
      return entries.length === 1 && entries[0]?.[0] === "nullable" && entries[0]?.[1] === true;
    });

    if (nullableOnlyIndex >= 0) {
      variants.splice(nullableOnlyIndex, 1);
      schema.nullable = true;
    }
  }

  for (const child of Object.values(schema)) {
    normalizeNullableAnyOf(child);
  }
}

generateSpec().catch(console.error);
