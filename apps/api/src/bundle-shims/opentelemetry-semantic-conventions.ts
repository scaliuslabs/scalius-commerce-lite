// The API Worker's "@opentelemetry/semantic-conventions" (apps/api/wrangler.jsonc
// `alias`). Better Auth's instrumentation imports four attribute names from
// it; Wrangler's build conditions (workerd, worker, browser) skip the
// package's ESM build for its CommonJS one, which cannot be tree-shaken, so
// every isolate compiled all 60 KiB of its constants. These are the same
// values: the build fails on a name this module lacks, and
// opentelemetry-semantic-conventions.test.ts checks each value against the package.
export const ATTR_DB_COLLECTION_NAME = "db.collection.name";
export const ATTR_DB_OPERATION_NAME = "db.operation.name";
export const ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code";
export const ATTR_HTTP_ROUTE = "http.route";
