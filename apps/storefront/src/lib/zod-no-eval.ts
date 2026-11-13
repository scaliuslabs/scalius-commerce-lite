// Every `zod` import in the storefront resolves here (astro.config.mjs,
// `resolve.alias`): Zod is told not to compile parsers with `new Function`
// before any module defines a schema. The page's Content-Security-Policy runs
// no `eval` (lib/inline-script-policy.ts), and Zod's own probe for it, made
// as the first schema is defined, would be a policy violation on every page
// that defines one. Workers already run Zod without compiling.
import { config } from "zod/v4";

config({ jitless: true });

export * from "zod/v4";
export { default } from "zod/v4";
