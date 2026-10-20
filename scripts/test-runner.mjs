#!/usr/bin/env node
/**
 * `pnpm test`: the whole suite in two passes (`scripts/test-passes.mjs`).
 * The parallel pass leaves the serial files out; the serial pass then runs
 * only them, on one worker. Every argument, file filter or flag, goes to the
 * passes: `pnpm test --reporter=dot` keeps the serial pass, and
 * `pnpm test <path>...` starts only the pass(es) that own those paths, so a
 * targeted run boots Vitest (config, global setup) once, not twice.
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolvePnpmExecutable } from "./dev-local-utils.mjs";
import { SERIAL_TESTS, TEST_PASS_ENV } from "./test-passes.mjs";

/** File filters among the arguments: paths, not flags or flag values. */
function fileFilters(args) {
  return args.filter((arg, index) => !arg.startsWith("-")
    && (arg.includes("/") || /\.test\.(?:c|m)?[jt]sx?$/.test(arg))
    && !(index > 0 && /^-(t|-testNamePattern|-reporter|-project|-outputFile[^=]*)$/.test(args[index - 1])));
}

/** Which passes a run needs: both without file filters, else the passes owning a filtered file. */
export function passesFor(args) {
  const filters = fileFilters(args);
  if (filters.length === 0) return { parallel: true, serial: true };
  const serialOnly = (filter) => SERIAL_TESTS.some((file) => file.endsWith(filter) || filter.endsWith(file));
  return {
    parallel: filters.some((filter) => !serialOnly(filter)),
    serial: filters.some((filter) => SERIAL_TESTS.some((file) => file.includes(filter) || filter.endsWith(file))),
  };
}

function vitest(pnpm, pass, args, passed) {
  const result = spawnSync(pnpm, ["exec", "vitest", "run", "--passWithNoTests", ...args, ...passed], {
    stdio: "inherit",
    env: { ...process.env, [TEST_PASS_ENV]: pass },
  });
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pnpm = resolvePnpmExecutable();
  const passed = process.argv.slice(2);
  const passes = passesFor(passed);
  const parallel = passes.parallel ? vitest(pnpm, "parallel", [], passed) : 0;
  const serial = passes.serial ? vitest(pnpm, "serial", ["--maxWorkers=1"], passed) : 0;
  process.exit(parallel || serial);
}
