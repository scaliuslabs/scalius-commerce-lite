// Wrangler bundles `*.txt` imports as Text modules (its default rule): the
// default export is the file's text. workerd does not compile a Text module at
// isolate start, so large generated data lives in one (apps/api/src/generated).
// Vitest (vitest.config.ts) and Node scripts (scripts/text-module-hooks.mjs)
// load them the same way.
declare module "*.txt" {
  const text: string;
  export default text;
}
