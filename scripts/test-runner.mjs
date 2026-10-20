#!/usr/bin/env node
/**
 * `pnpm test`: the whole suite in two passes (`scripts/test-passes.mjs`).
 * The parallel pass leaves the serial files out; the serial pass then runs
 * only them, on one worker. Every argument, file filter or flag, goes to both
 * passes: `pnpm test --reporter=dot` keeps the serial pass, and
 * `pnpm test <path>` runs that file in the pass that owns it (the other pass
 * finds no file and passes).
 */
import { spawnSync } from "node:child_process";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";
import { TEST_PASS_ENV } from "./test-passes.mjs";

const pnpm = resolvePnpmExecutable();
const passed = process.argv.slice(2);

function vitest(pass, args) {
  const result = spawnSync(pnpm, ["exec", "vitest", "run", "--passWithNoTests", ...args, ...passed], {
    stdio: "inherit",
    env: { ...process.env, [TEST_PASS_ENV]: pass },
  });
  return result.status ?? 1;
}

const parallel = vitest("parallel", []);
const serial = vitest("serial", ["--maxWorkers=1"]);
process.exit(parallel || serial);
