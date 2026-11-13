// The dashboard's policy runs no `eval` or `new Function` (packages/shared
// http-security.ts, dashboardDocumentCsp). Zod compiles object parsers with
// `new Function` unless told not to, and probes for it on first use (each
// probe a policy violation report): it validates without compiling here.
// Imported first in main.tsx, before any module defines a schema. Zod reads
// its config from `globalThis.__zod_globalConfig` (zod/v4/core core.js), so
// this sets it there without importing Zod: the sign-in page, which defines
// no schema, never downloads Zod for it.
const page = globalThis as typeof globalThis & { __zod_globalConfig?: { jitless?: boolean } };
Object.assign((page.__zod_globalConfig ??= {}), { jitless: true });

export {};
