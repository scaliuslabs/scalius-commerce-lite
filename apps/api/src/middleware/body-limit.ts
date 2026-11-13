// The one request-body limit of every API route: the matched route's class
// (runtime/route-limits.ts ROUTE_BODY_RULES), enforced before any middleware
// or route reads the body. Route groups register it first (route-groups.ts),
// so production and the contract app bound bodies alike.
//
// A declared length past the class is refused at once. Any other body is
// counted as it streams (chunked, or a declared length that lies): the read
// that passes the class fails, and whatever the route answered then, the
// answer is 413. Nothing is buffered here, so a large upload part still
// streams to storage.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { limitRequestBody, PayloadTooLargeError } from "@scalius/shared/request-body-limit";
import { errorResponseFromError } from "../utils/api-response";
import { AppError } from "../utils/api-error";
import { routeBodyLimitOf } from "../runtime/route-limits";

function tooLarge(c: Context, maxBytes: number): Response {
  const { body, status } = errorResponseFromError(
    new AppError(413, "payload_too_large", `This request is too large. Send at most ${maxBytes} bytes.`, { maxBytes }),
  );
  return c.json(body, status, { "Cache-Control": "private, no-store" });
}

/** The ceiling of the route Hono will answer with, or of the request's own path when only a catch-all matched. */
export function requestBodyLimit(c: Context): number {
  const route = matchedRoutes(c).find((candidate) => candidate.method !== "ALL");
  return route ? routeBodyLimitOf(route.method, route.path) : routeBodyLimitOf(c.req.method, c.req.path);
}

export const requestBodyLimitMiddleware: MiddlewareHandler = async (c, next) => {
  if (c.req.raw.body === null && !c.req.header("content-length")) return next();
  const maxBytes = requestBodyLimit(c);
  let limited: ReturnType<typeof limitRequestBody>;
  try {
    limited = limitRequestBody(c.req.raw, maxBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return tooLarge(c, maxBytes);
    throw error;
  }
  if (limited.request !== c.req.raw) {
    c.req.raw = limited.request;
    c.req.bodyCache = {};
  }
  await next();
  if (limited.exceeded()) c.res = tooLarge(c, maxBytes);
};
