#!/usr/bin/env node
/**
 * deploy.mjs — Full deploy pipeline for the storefront Cloudflare Worker
 *
 * Usage:
 *   node scripts/deploy.mjs        # full deploy (build + deploy)
 *   pnpm deploy                    # same via npm script
 *
 * Runs in order:
 *   1. node scripts/generate-build-id.js  — stamp build with unique ID for cache busting
 *   2. astro check                        — TypeScript type checking
 *   3. astro build                        — compile Astro SSR + client assets
 *   4. wrangler deploy                    — upload and activate the Worker
 */

import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

function run(cmd, label) {
    console.log(`\n▶ ${label}`);
    console.log(`  $ ${cmd}\n`);
    execSync(cmd, { cwd: root, stdio: "inherit" });
}

(async () => {
    console.log("\n🚀 Deploying storefront\n");
    console.log("=".repeat(60));

    try {
        // 1. Generate build ID for cache busting
        run("node scripts/generate-build-id.js", "Generate build ID");

        // 2. Type check
        run("npx astro check", "TypeScript check");

        // 3. Build (SSR + client assets)
        run("npx astro build", "Build storefront");

        // 4. Deploy to Cloudflare Workers
        run("npx wrangler deploy", "Deploy Worker to Cloudflare");

        console.log("\n✓ Deploy complete.");
    } catch {
        console.error("\n✗ Deploy failed. See error above.");
        process.exit(1);
    }
})();
