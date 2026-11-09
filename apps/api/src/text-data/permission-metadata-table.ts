// The API Worker's "#permission-metadata-table" (apps/api/wrangler.jsonc
// `alias`): the permission table of
// packages/core/src/auth/rbac/permission-metadata-table.ts, parsed from a Text
// module (../generated/permission-metadata-table.gen.txt, `pnpm regen`) when
// it is first read, instead of a literal compiled at every isolate start.
// text-data.test.ts proves the copy equals the source.
import type { PermissionMetadata } from "@scalius/core/auth/rbac/types";
// A Text module: a string, not compiled at isolate start.
import table from "../generated/permission-metadata-table.gen.txt";

export const PERMISSION_METADATA: Record<string, PermissionMetadata> = JSON.parse(table);
