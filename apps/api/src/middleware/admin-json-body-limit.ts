import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorResponseFromError } from "../utils/api-response";
import { AppError } from "../utils/api-error";

/**
 * The largest JSON body a dashboard or agent operation reads. A rich-text
 * field takes at most 800,000 raw characters (packages/core/src/utils/rich-text.ts),
 * up to three bytes each in Bangla, so a product with a long description and
 * long additional information fits; megabytes of padding are refused before
 * the JSON is parsed. Uploads (multipart, octet-stream) keep their own limits.
 */
export const MAX_ADMIN_JSON_BODY_BYTES = 8 * 1024 * 1024;

const limit = bodyLimit({
  maxSize: MAX_ADMIN_JSON_BODY_BYTES,
  onError: (c) => {
    const { body, status } = errorResponseFromError(
      new AppError(413, "payload_too_large", `Send at most ${MAX_ADMIN_JSON_BODY_BYTES} bytes of JSON in one request.`),
    );
    return c.json(body, status);
  },
});

export const adminJsonBodyLimitMiddleware: MiddlewareHandler = (c, next) =>
  /\bjson\b/i.test(c.req.header("content-type") ?? "") ? limit(c, next) : next();
