// `scalius-plugin <command>`: the SDK's own CLI (dist/cli.js in the published
// package), for an app outside any Scalius checkout. scripts/build-plugin-sdk.mjs
// bundles it with scripts/plugin-host.sdk.mjs as its host; the commands are
// the ones `pnpm plugin` runs in a checkout (scripts/plugin-authoring.mjs).

import { addThroughCheckout, authoringHelp, buildApps, runAuthoring } from "./plugin-authoring.mjs";
import { CLI, SDK_DIR } from "./plugin-host.mjs";
import { parseCommandArgs } from "./plugin-registry.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HELP = new Set([undefined, "help", "--help", "-h"]);

async function main([command, ...rest]) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 21)) throw new Error(`Node 24.21 or newer is required; this is ${process.versions.node}.`);
  if (command === "--version" || command === "-v") {
    console.log(JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8")).version);
    return;
  }
  if (command === "build") return buildApps(parseCommandArgs(rest).positional);
  if (command === "add") {
    const parsed = parseCommandArgs(rest);
    return addThroughCheckout(parsed.positional[0], parsed.flags);
  }
  if (await runAuthoring(command, rest)) return;
  console.log([
    ...authoringHelp(),
    `${CLI} add [app] --scalius <checkout>`.padEnd(64) + "  install the app in a Scalius store checkout (its pnpm plugin add)",
    `${CLI} --version`.padEnd(64) + "  the SDK version",
  ].join("\n"));
  if (!HELP.has(command)) {
    console.error(`✗ Unknown command: ${command}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
