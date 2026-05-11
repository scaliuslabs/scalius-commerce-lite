import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(__dirname, "../../..");

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

function writeSpec(spec: any) {
  const outputPath = resolve(__dirname, "../openapi.json");
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));
  console.log(`OpenAPI spec written to ${outputPath}`);
  console.log(`Routes documented: ${Object.keys(spec.paths || {}).length}`);
}

generateSpec().catch(console.error);
