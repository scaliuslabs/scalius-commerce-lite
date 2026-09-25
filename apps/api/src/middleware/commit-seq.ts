import type { MiddlewareHandler } from "hono";
import { CACHE_COMMIT_SEQ_HEADER } from "@scalius/shared/cache-frontier";
import type { Database } from "@scalius/database/client";
import { readCommitSeq } from "../cache-frontier";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Read-your-writes for the merchant (CACHE-DESIGN §6.10): a successful admin
 * write answers with `X-Scalius-Commit-Seq`, the store's change clock after
 * the handler committed. The dashboard carries it into "view on store" links
 * (`_sv`), and the storefront refreshes its frontier to at least that value
 * before it validates a cached page. One clock read per successful write;
 * a failed read omits the header and never fails the write.
 */
export const commitSeqMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  if (READ_METHODS.has(c.req.method) || c.res.status >= 400) return;
  const db = c.get("db") as Database | undefined;
  if (!db) return;
  try {
    const seq = String(await readCommitSeq(db));
    try {
      c.res.headers.set(CACHE_COMMIT_SEQ_HEADER, seq);
    } catch {
      // Immutable headers (a proxied response): copy it once.
      const response = new Response(c.res.body, c.res);
      response.headers.set(CACHE_COMMIT_SEQ_HEADER, seq);
      c.res = response;
    }
  } catch {
    // The clock is a hint for the merchant's own links; the write stands.
  }
};
