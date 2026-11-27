// apps/api/src/release.ts
// The runtime release identity reported by `GET /api/v1/meta`.
//
// Automation must not infer compatibility from a Worker build timestamp, so
// the API states its release, the API majors it serves, and (via the database
// ledger) the schema revision it expects. The release is the platform's one
// version, `SCALIUS_PLATFORM_VERSION` (@scalius/shared/plugins/api-version):
// the root package version, the SDK's, and what an app's `minPlatformVersion`
// is checked against.

export const API_RELEASE_NAME = "scalius-commerce" as const;
/** API majors served by this release; `/api/v1` is the current one. */
export const API_SUPPORTED_MAJORS = ["v1"] as const;
export const API_CURRENT_MAJOR = "v1" as const;
