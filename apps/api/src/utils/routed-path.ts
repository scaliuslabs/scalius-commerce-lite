// The one path every authorization lookup reads (audit R2 F7).
//
// Hono routes on the request path decoded once (`decodeURI`, a literal `%25`
// kept as `%25`). `new URL(url).pathname` stays percent-encoded, so a lookup
// that read it could disagree with the router: `/conversations/%61ssignees`
// would match the `/conversations/*` rule while the router runs the
// `/conversations/assignees` route. Route permissions, the agent and plugin
// operation lookups, the scanner allowlist and idempotent replay all read
// this instead, so they see exactly the route that runs.

/** The routed path with the `/api/v1` prefix the permission and operation maps use. */
export function routedApiPath(c: { req: { path: string } }): string {
  const pathname = c.req.path;
  return pathname.startsWith("/api/v1") ? pathname : `/api/v1${pathname}`;
}
