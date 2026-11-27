// `error.details` as an app receives it from `ctx.api.call`: only for a code
// that declares them (`APP_ERROR_CODES[code].details`), projected to the
// declared keys. Apart from the table so a bundle that reads the codes does
// not carry the projector.

import { APP_ERROR_CODES, isAppErrorCode, type AppErrorCodeEntry } from "./app-errors";
import { schemaProjector, type SchemaProjector } from "../schema-projection";

const detailsProjectors = new Map<string, SchemaProjector>();

/**
 * The `error.details` an app receives with `code`: the refusal's details
 * projected to the code's declared keys, each declared list cut to its
 * `maxItems`; undefined for a code that declares none (or no details).
 */
export function appErrorDetails(code: string, details: unknown): Record<string, unknown> | undefined {
  const declared = isAppErrorCode(code) ? (APP_ERROR_CODES[code] as AppErrorCodeEntry).details : undefined;
  if (!declared || typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  let project = detailsProjectors.get(code);
  if (!project) {
    project = schemaProjector(declared);
    detailsProjectors.set(code, project);
  }
  const projected = project(details as Record<string, unknown>);
  const properties = (declared.properties ?? {}) as Record<string, { maxItems?: number }>;
  for (const [key, value] of Object.entries(projected)) {
    const max = properties[key]?.maxItems;
    if (Array.isArray(value) && typeof max === "number" && value.length > max) projected[key] = value.slice(0, max);
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}
