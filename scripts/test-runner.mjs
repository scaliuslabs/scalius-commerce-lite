#!/usr/bin/env node
/**
 * `pnpm test`: the whole suite in two passes. The Turso/D1 export tests each
 * build a full migrated database and run for minutes on their own, so beside
 * the parallel suite they miss their own time limits; they run afterwards,
 * one worker, alone. With file filters (`pnpm test <path>`) vitest runs
 * exactly those files in one pass.
 */
import { spawnSync } from "node:child_process";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";

export const SERIAL_TESTS = [
  "packages/database/__tests__/export-turso-portable.test.ts",
  "packages/database/__tests__/prepare-live-checkout-target.test.ts",
  "packages/database/__tests__/turso-upload-bundle.test.ts",
];

const pnpm = resolvePnpmExecutable();

function vitest(args) {
  const result = spawnSync(pnpm, ["exec", "vitest", "run", "--passWithNoTests", ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

const passed = process.argv.slice(2);
if (passed.length > 0) {
  process.exit(vitest(passed));
}
const parallel = vitest(SERIAL_TESTS.flatMap((file) => ["--exclude", file]));
const serial = vitest(["--maxWorkers=1", ...SERIAL_TESTS]);
process.exit(parallel || serial);
