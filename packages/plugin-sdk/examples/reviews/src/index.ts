// Reviews (`acme.reviews`): a product reviews app on the stable app API only
// (app operation names through `ctx.api.call`), the way a review import from
// another platform or a reviews service works:
//
// - `import` (POST) writes reviews (`reviews.create`), each under an
//   Idempotency-Key made from the source's own review key, so an import that
//   runs again writes nothing twice. A review the source ties to a delivered
//   order line names it (`orderItemId`) and is a verified purchase; history
//   without one is written as such, never claimed verified.
// - `queue` (GET) lists the reviews waiting for moderation
//   (`reviews.list`, status `pending`) with their products' names
//   (`products.get`, read_products); the reviewer's name reads null, since
//   the app has no `read_customer_names`.
// - `queue` (POST) moderates (`reviews.set_status`) under the revision read:
//   one review as the merchant decided, or every pending one by the app's
//   rule (spam phrases rejected as spam, the rest published).

import { definePlugin, PLUGIN_API_VERSION, ui, type PluginApiResult, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.reviews",
  name: "Reviews",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Imports product reviews from another platform and moderates new ones.",
  author: { name: "Acme" },
  scopes: ["read_products", "write_reviews"],
  routes: {
    admin: [
      { name: "import", methods: ["POST"], description: "Import reviews from another platform." },
      { name: "queue", methods: ["GET", "POST"], description: "The reviews waiting for moderation." },
    ],
  },
} satisfies PluginManifestInput;

/** A review as the source platform exports it. */
export type ImportedReview = {
  /** The source's own id of the review: the import's retry key. */
  key: string;
  productId: string;
  rating: number;
  title?: string | null;
  body?: string | null;
  authorDisplayName?: string | null;
  /** The order line the source says was bought (a verified purchase). */
  orderItemId?: string | null;
  customerId?: string | null;
  createdAt?: string;
  status?: "pending" | "published";
  verified?: boolean;
};

/** A review as the app reads it (`ReviewResource`). */
export type AppReview = {
  id: string;
  productId: string;
  status: string;
  rating: number;
  title: string | null;
  body: string | null;
  authorDisplayName: string | null;
  verified: boolean;
  appId: string | null;
  revision: number;
};

type ReviewPage = { reviews: AppReview[]; nextCursor: string | null };

/** Phrases the app rejects as spam. */
const SPAM = /\b(free money|click here|cheap pills)\b/iu;

/** The Idempotency-Key of one source review: the same review always maps to it. */
export const importKey = (key: string) => `acme-reviews-${key}`;

async function pending(ctx: PluginContext): Promise<AppReview[]> {
  const reviews: AppReview[] = [];
  let cursor: string | null = null;
  do {
    const page: PluginApiResult<ReviewPage> = await ctx.api.call<ReviewPage>("reviews.list", {
      query: { status: "pending", limit: 50, ...(cursor ? { cursor } : {}) },
    });
    if (!page.ok || !page.data) throw new Error(`reviews.list: ${page.error?.code ?? page.status}`);
    reviews.push(...page.data.reviews);
    cursor = page.data.nextCursor;
  } while (cursor);
  return reviews;
}

async function moderate(ctx: PluginContext, review: Pick<AppReview, "id" | "revision">, status: "published" | "rejected", reason?: string) {
  const result = await ctx.api.call<{ review: AppReview }>("reviews.set_status", {
    path: { id: review.id },
    body: { status, ...(reason ? { reason } : {}), expectedRevision: review.revision },
    idempotencyKey: `acme-reviews-moderate-${review.id}-${review.revision}-${status}`,
  });
  return { reviewId: review.id, status: result.ok ? result.data?.review.status ?? null : null, code: result.error?.code ?? null };
}

export default definePlugin({
  manifest,
  routes: {
    admin: {
      import: async (request, ctx) => {
        const items = ((request.body ?? {}) as { reviews?: ImportedReview[] }).reviews ?? [];
        const results = [];
        for (const { key, ...review } of items) {
          const written = await ctx.api.call<{ review: AppReview }>("reviews.create", { body: review, idempotencyKey: importKey(key) });
          results.push({ key, reviewId: written.data?.review.id ?? null, verified: written.data?.review.verified ?? null, code: written.error?.code ?? null });
        }
        return { body: { results } };
      },
      queue: async (request, ctx) => {
        if (request.method === "POST") {
          const body = (request.body ?? {}) as { reviewId?: string; status?: "published" | "rejected"; reason?: string; expectedRevision?: number };
          if (body.reviewId && body.status && typeof body.expectedRevision === "number") {
            return { body: { moderated: [await moderate(ctx, { id: body.reviewId, revision: body.expectedRevision }, body.status, body.reason)] } };
          }
          const moderated = [];
          for (const review of await pending(ctx)) {
            const spam = SPAM.test(`${review.title ?? ""} ${review.body ?? ""}`);
            moderated.push(await moderate(ctx, review, spam ? "rejected" : "published", spam ? "spam" : undefined));
          }
          return { body: { moderated } };
        }
        const reviews = await pending(ctx);
        const names = new Map<string, string>();
        for (const productId of new Set(reviews.map((review) => review.productId))) {
          const product = await ctx.api.call<{ product: { name: string } }>("products.get", { path: { id: productId } });
          names.set(productId, product.data?.product.name ?? productId);
        }
        return {
          body: ui.page([
            reviews.length === 0
              ? ui.empty("Nothing waits for moderation")
              : ui.table({
                columns: [{ key: "product", label: "Product" }, { key: "rating", label: "Rating" }, { key: "title", label: "Title" }, { key: "author", label: "By" }],
                rows: reviews.map((review) => ({
                  id: review.id,
                  cells: {
                    product: names.get(review.productId) ?? review.productId,
                    rating: review.rating,
                    title: review.title ?? "",
                    // Without read_customer_names the reviewer's name reads null.
                    author: review.authorDisplayName ?? "A customer",
                  },
                })),
              }),
          ], { title: "Reviews waiting" }),
        };
      },
    },
  },
});
