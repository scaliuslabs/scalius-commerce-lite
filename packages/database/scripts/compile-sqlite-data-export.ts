import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createSqliteDataExportEnvelopeForProvider } from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
  readFinalTriggerDefinitions,
} from "./sqlite-provider-schema";

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

async function leadingDeferredForeignKeyPragmaBytes(input: string): Promise<number> {
  const handle = await open(input, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const preview = buffer.subarray(0, bytesRead).toString("utf8");
    const match = preview.match(
      /^\s*PRAGMA\s+defer_foreign_keys\s*=\s*TRUE\s*;\s*/i,
    );
    return match ? Buffer.byteLength(match[0], "utf8") : 0;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.input === options.output) {
    throw new Error("--input and --out must be different files.");
  }
  const providerSchema = options.provider === "turso"
    ? await (async () => {
        const schemaDatabase = await createProviderSchemaDatabase("turso");
        try {
          return {
            tables: readApplicationTableNames(schemaDatabase),
            triggers: readFinalTriggerDefinitions(schemaDatabase),
          };
        } finally {
          schemaDatabase.close();
        }
      })()
    : { tables: [], triggers: [] };
  const envelope = createSqliteDataExportEnvelopeForProvider(
    options.provider,
    providerSchema.triggers,
    providerSchema.tables,
  );
  const skippedPrefixBytes = options.provider === "turso"
    ? await leadingDeferredForeignKeyPragmaBytes(options.input)
    : 0;
  const sourceHash = createHash("sha256");
  const compiledHash = createHash("sha256");
  let sourceBytes = 0;
  let compiledBytes = 0;
  let remainingSkip = skippedPrefixBytes;
  let lastBodyByte: number | undefined;
  let sawBodyContent = false;

  const compiledStream = Readable.from((async function* () {
    if (envelope.prefix) {
      const prefix = Buffer.from(envelope.prefix);
      compiledHash.update(prefix);
      compiledBytes += prefix.length;
      yield prefix;
    }

    for await (const rawChunk of createReadStream(options.input)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      sourceHash.update(chunk);
      sourceBytes += chunk.length;

      let body = chunk;
      if (remainingSkip > 0) {
        if (body.length <= remainingSkip) {
          remainingSkip -= body.length;
          continue;
        }
        body = body.subarray(remainingSkip);
        remainingSkip = 0;
      }
      if (body.length === 0) continue;
      if (!sawBodyContent && /\S/.test(body.toString("utf8"))) {
        sawBodyContent = true;
      }
      lastBodyByte = body.at(-1);
      compiledHash.update(body);
      compiledBytes += body.length;
      yield body;
    }

    if (!sawBodyContent) {
      throw new Error("SQLite data export must not be empty.");
    }
    if (envelope.suffix) {
      if (lastBodyByte !== 0x0a) {
        const newline = Buffer.from("\n");
        compiledHash.update(newline);
        compiledBytes += newline.length;
        yield newline;
      }
      const suffix = Buffer.from(envelope.suffix);
      compiledHash.update(suffix);
      compiledBytes += suffix.length;
      yield suffix;
    }
  })());

  const outputHandle = await open(options.output, "wx", 0o600);
  try {
    await pipeline(
      compiledStream,
      outputHandle.createWriteStream(),
    );
  } catch (error) {
    await outputHandle.close().catch(() => undefined);
    await rm(options.output, { force: true });
    throw error;
  }
  process.stdout.write(`${JSON.stringify({
    provider: options.provider,
    suspendedTriggers: providerSchema.triggers.length,
    clearedTables: providerSchema.tables.length,
    skippedPrefixBytes,
    sourceBytes,
    compiledBytes,
    sourceSha256: sourceHash.digest("hex"),
    compiledSha256: compiledHash.digest("hex"),
    output: options.output,
  })}\n`);
}

await main();
