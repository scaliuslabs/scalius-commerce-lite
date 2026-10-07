// The reference app (plugins/hello) exercises every surface, but it is a
// sample: scalius.plugins.json does not bundle it, so no store deploys it.
// The platform's tests still run it through the bundled loader. A test adds
// it to the bundled registry with:
//
//   vi.mock("./bundled.gen", async (importOriginal) =>
//     (await import("./testing/hello-bundled")).withHelloBundled(await importOriginal()));
//
// Its fingerprint is a fixed test value: an installation made from this entry
// matches the "deployed" code, and a test that changes it sees an update.

import { manifest as helloManifest } from "../../../../../plugins/hello/src/index";
import type { BundledPluginEntry } from "../loaders/bundled";

export const HELLO_BUNDLED: BundledPluginEntry = {
  version: helloManifest.version,
  sha256: "5a1e".repeat(16),
  load: () => import("../../../../../plugins/hello/src/index"),
};

export function withHelloBundled<T extends { BUNDLED_PLUGINS: Readonly<Record<string, BundledPluginEntry>> }>(module: T): T {
  return { ...module, BUNDLED_PLUGINS: { ...module.BUNDLED_PLUGINS, "scalius.hello": HELLO_BUNDLED } };
}
