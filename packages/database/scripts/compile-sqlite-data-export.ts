import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compileSqliteDataExportForProvider } from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv: readonly string[]): {
  provider: DatabaseProvider;
  input: string;
  output: string;
} {
  let provider: string | undefined;
  let input: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--provider") provider = argv[++index];
    else if (argument === "--input") input = argv[++index];
    else if (argument === "--out") output = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (provider !== "d1" && provider !== "turso") {
    throw new Error("--provider must be d1 or turso.");
  }
  if (!input?.trim()) throw new Error("--input is required.");
  if (!output?.trim()) throw new Error("--out is required.");
  return { provider, input: resolve(input), output: resolve(output) };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const source = await readFile(options.input, "utf8");
  const compiled = compileSqliteDataExportForProvider(source, options.provider);
  await writeFile(options.output, compiled, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    provider: options.provider,
    sourceSha256: sha256(source),
    compiledSha256: sha256(compiled),
    output: options.output,
  })}\n`);
}

await main();
