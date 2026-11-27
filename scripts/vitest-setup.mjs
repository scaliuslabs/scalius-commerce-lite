// Unit tests stub `globalThis.fetch` on purpose (`vi.stubGlobal`) and expect
// host code to reach the stub. The bundled loader's egress guard otherwise
// keeps the fetch captured at module load and locks the property; this flag
// (read once when that module loads) lets it follow the stub instead. A test
// of the real behaviour deletes the flag in `vi.hoisted`.
Reflect.set(globalThis, Symbol.for("scalius.plugins.ambientHostFetch"), true);

// A refusal whose code declares the details apps read (APP_ERROR_CODES) and
// whose producer sends another shape throws where it is made, so every test
// that drives a producer holds it to the sealed shape (production logs it).
Reflect.set(globalThis, Symbol.for("scalius.appErrorDetails.strict"), true);

// Background work handed to a test execution context (scripts/test-background.mjs) never outlives its file: a file
// that ends with such work still pending, or rejected, fails (its logs would land after the file, and at the worker's
// teardown fail a green run).
import { afterAll, beforeAll } from "vitest";
import { unsettledBackground } from "./test-background.mjs";

beforeAll(() => { unsettledBackground(); });
afterAll(async () => {
  // A task that is about to land gets a few turns of the event loop.
  for (let turn = 0; turn < 3; turn += 1) await new Promise((done) => setTimeout(done, 0));
  const { pending, rejected } = unsettledBackground();
  if (pending > 0 || rejected.length > 0) {
    throw new Error(`background work handed to waitUntil was ${pending > 0 ? `still pending (${pending})` : ""}${pending > 0 && rejected.length > 0 ? " and " : ""}${rejected.length > 0 ? `rejected (${rejected.length}: ${String(rejected[0].error).slice(0, 200)})` : ""} at the file's end: settle it (settleTestBackground) before the test's database closes`);
  }
});
