// The dashboard's policy runs no `eval` or `new Function` (packages/shared
// http-security.ts, dashboardDocumentCsp). Zod compiles object parsers with
// `new Function` unless told not to, and probes for it on first use (each
// probe a policy violation report): it validates without compiling here.
// Imported first in main.tsx, before any module defines a schema.
import { config } from "zod";

config({ jitless: true });
