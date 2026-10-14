// `node --import <this file>`: a `*.txt` import is its text, as Wrangler bundles
// it (a Text module) and Vitest loads it (vitest.config.ts). The API keeps its
// large generated data in Text modules (apps/api/src/generated/*.gen.txt).
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".txt")) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
