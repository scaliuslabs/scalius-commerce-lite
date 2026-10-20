/**
 * The two passes of `pnpm test` (`scripts/test-runner.mjs`), read by
 * `vitest.config.ts`. The Turso/D1 export tests each build a full migrated
 * database and run for minutes on their own, so beside the parallel suite
 * they miss their own time limits; they run in a second pass, alone.
 *
 * Vitest applies a CLI `--exclude` to the root config only, never to files a
 * project collects, so the split lives in the config:
 * `SCALIUS_TEST_PASS=parallel` leaves these files out and
 * `SCALIUS_TEST_PASS=serial` collects only them. Unset, vitest sees every file.
 */
export const SERIAL_TESTS = [
  "packages/database/__tests__/export-turso-portable.test.ts",
  "packages/database/__tests__/prepare-live-checkout-target.test.ts",
  "packages/database/__tests__/turso-upload-bundle.test.ts",
];

export const TEST_PASS_ENV = "SCALIUS_TEST_PASS";

/** @returns {"parallel" | "serial" | undefined} */
export function testPass(env = process.env) {
  const pass = env[TEST_PASS_ENV];
  if (pass === undefined || pass === "") return undefined;
  if (pass === "parallel" || pass === "serial") return pass;
  throw new Error(`${TEST_PASS_ENV} must be "parallel" or "serial", got "${pass}"`);
}
