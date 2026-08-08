import { bodyLimit } from "hono/body-limit";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export const webhookBodyLimitMiddleware = bodyLimit({
  maxSize: MAX_WEBHOOK_BODY_BYTES,
  onError: (c) => c.json({
    success: false,
    error: "Webhook payload too large",
  }, 413),
});
