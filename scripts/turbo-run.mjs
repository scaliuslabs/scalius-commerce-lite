#!/usr/bin/env node
import { spawnSync } from "child_process";
import { delimiter, dirname } from "path";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

const turboArgs = process.argv.slice(2);

if (turboArgs.length === 0) {
  console.error("Usage: node scripts/turbo-run.mjs <turbo run args...>");
  process.exit(1);
}

const pnpmExecutable = resolvePnpmExecutable();
const env = {
  ...process.env,
  SCALIUS_PNPM_BIN: pnpmExecutable,
  PATH: `${dirname(pnpmExecutable)}${delimiter}${process.env.PATH || ""}`,
};

const result = spawnSync(
  pnpmExecutable,
  ["exec", "turbo", "run", ...turboArgs],
  {
    env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
