import { ERROR_MESSAGES } from "@scalius/core/modules/ai";
import { getClientIp, rateLimit } from "@scalius/shared/rate-limit";
import { RateLimitError } from "../../utils/api-error";
import type { ApiContext } from "./ai-chat-contract";

const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

export async function enforceAiRateLimit(c: ApiContext): Promise<void> {
  const kv = c.env.CACHE as KVNamespace | undefined;
  if (!kv) return;

  const user = c.get("user") as { id?: string } | undefined;
  const identity = user?.id || getClientIp(c.req.raw);
  const result = await rateLimit({
    kv,
    key: `admin-ai:${identity}`,
    limit: AI_RATE_LIMIT.limit,
    windowMs: AI_RATE_LIMIT.windowMs,
  });

  if (!result.allowed) {
    throw new RateLimitError(
      ERROR_MESSAGES.rateLimitError,
      Math.ceil((result.resetAt - Date.now()) / 1000),
    );
  }
}
