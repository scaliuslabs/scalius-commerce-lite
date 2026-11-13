import { BUILD_ID } from "@/config/build-id";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { apiFetch } from "./transport";
import { unwrapEnvelope } from "./unwrap";
import { isIdentifierNotFound, refusalBody } from "./identifier-read";
import type { Page, PaginatedResponse } from "./types";

export interface ArticleListOptions {
  page?: number;
  limit?: number;
  tag?: string;
}

interface ArticleListPayload {
  articles: Page[];
  pagination: PaginatedResponse<Page>["pagination"];
}

export async function getArticles(
  options: ArticleListOptions = {},
): Promise<PaginatedResponse<Page> | null> {
  const params = new URLSearchParams();
  if (options.page) params.set("page", String(options.page));
  if (options.limit) params.set("limit", String(options.limit));
  if (options.tag) params.set("tag", options.tag);
  const query = params.toString();

  return withEdgeCache(
    `all_articles_${query || "default"}_${BUILD_ID}`,
    async () => {
      try {
        const response = await apiFetch(
          `/articles${query ? `?${query}` : ""}`,
          {},
          { retries: 2, timeout: 5_000, auth: false },
        );
        if (!response.ok) return null;
        const payload = unwrapEnvelope<ArticleListPayload>(
          await response.json(),
        );
        return payload
          ? { data: payload.articles, pagination: payload.pagination }
          : null;
      } catch (error: unknown) {
        console.error("Error fetching articles:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * A published article: `"missing"` when no article has this handle (the 404
 * page), null when the read failed (503, never a false 404).
 */
export async function getArticleBySlug(slug: string): Promise<Page | "missing" | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return "missing";

  return withEdgeCache<Page | "missing">(
    `article_slug_${slug}_${BUILD_ID}`,
    async () => {
      try {
        const response = await apiFetch(
          `/articles/slug/${encodeURIComponent(slug)}`,
          {},
          { retries: 2, timeout: 5_000, auth: false },
        );
        if (isIdentifierNotFound(response.status, await refusalBody(response), ["slug"])) return "missing";
        if (!response.ok) return null;
        return (
          unwrapEnvelope<{ article: Page }>(await response.json())?.article ??
          null
        );
      } catch (error: unknown) {
        console.error(`Error fetching article "${slug}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
