import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const generatedDir = resolve(__dirname, "../src/generated");
const clientShimPath = resolve(generatedDir, "client-core.ts");
const clientGenPath = resolve(generatedDir, "client.gen.ts");
const sdkGenPath = resolve(generatedDir, "sdk.gen.ts");

const shim = `// Generated post-process shim for dev/runtime module resolution.
// The generated SDK sources need a stable local module, while the repo runs the
// packages directly from source in Vite/Workers dev. Re-export the official ESM
// runtime package instead of the generated CommonJS bundle.
export * from "@hey-api/client-fetch";
`;

mkdirSync(dirname(clientShimPath), { recursive: true });
writeFileSync(clientShimPath, shim);
console.log(\`Generated runtime shim at \${clientShimPath}\`);

const clientGen = readFileSync(clientGenPath, "utf8").replaceAll(
  "from './client';",
  "from './client-core';",
);
writeFileSync(clientGenPath, clientGen);

const sdkGen = readFileSync(sdkGenPath, "utf8").replaceAll(
  "from './client';",
  "from './client-core';",
);
writeFileSync(sdkGenPath, sdkGen);

console.log("Rewrote generated imports to ./client-core");
