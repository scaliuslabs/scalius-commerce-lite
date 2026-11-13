/**
 * The body ceiling of the endpoints the Worker entry answers before the route
 * groups: the storefront's frontier check (at most 256 twelve-character
 * hashes) and its incident report (at most 20 short incidents). The form class
 * of runtime/route-limits.ts, inlined so the frontier check, the hottest call,
 * loads no route table (worker-entry-body-limit.test.ts pins the two).
 *
 * It lives in its own module because the Workers runtime refuses to start a
 * Worker whose entry module exports anything but handlers and classes.
 */
export const ENTRY_BODY_BYTES = 48 * 1024;
