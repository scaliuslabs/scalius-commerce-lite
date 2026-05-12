import type * as CssTree from "css-tree";

// The package's default ESM entry reaches Node createRequire in Cloudflare
// Workers. The bundled ESM build is browser/Worker-safe but has no published
// declaration file, so this wrapper pins the runtime path while preserving the
// public css-tree types for callers.
// @ts-expect-error css-tree does not publish types for this export path.
import * as cssTreeRuntime from "css-tree/dist/csstree.esm";

const cssTree = cssTreeRuntime as typeof CssTree;

export default cssTree;
