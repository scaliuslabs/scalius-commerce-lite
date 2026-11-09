// The API Worker's "#notification-default-copy" (apps/api/wrangler.jsonc
// `alias`): the default notification copy of
// packages/core/src/modules/notifications/notification-default-copy.ts, parsed
// from a Text module (../generated/notification-default-copy.gen.txt,
// `pnpm regen`) when a template is first resolved, instead of literals
// compiled at every isolate start. text-data.test.ts proves the copy equals the source.
// A Text module: a string, not compiled at isolate start.
import copy from "../generated/notification-default-copy.gen.txt";

type DefaultCopy = Record<string, { subject: string; message: string; sms: string }>;

export const NOTIFICATION_DEFAULT_COPY: Record<"en" | "bn", { greeting: string; events: DefaultCopy }> = JSON.parse(copy);
