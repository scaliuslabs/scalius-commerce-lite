// apps/api/src/release.ts
// The runtime release identity reported by `GET /api/v1/meta`.
//
// Automation must not infer compatibility from a Worker build timestamp, so
// the API states its release version, the API majors it serves, and (via the
// database ledger) the schema revision it expects. `release.test.ts` keeps
// this constant equal to `apps/api/package.json`.

export const API_RELEASE_NAME = "scalius-commerce" as const;
export const API_RELEASE_VERSION = "1.0.0" as const;
/** API majors served by this release; `/api/v1` is the current one. */
export const API_SUPPORTED_MAJORS = ["v1"] as const;
export const API_CURRENT_MAJOR = "v1" as const;
