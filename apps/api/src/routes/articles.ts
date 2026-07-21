import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  getPublicArticleBySlug,
  getPublicArticles,
} from "@scalius/core/modules/pages/pages.service";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError } from "../utils/api-error";
import { ok } from "../utils/api-response";
import {
  errorResponses,
  paginationSchema,
  successEnvelope,
} from "../schemas/responses";
import { pageSchema } from "../schemas/entities";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:pages:articles:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

const articleListQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(24).default(12),
  page: z.coerce.number().min(1).default(1),
  tag: z.string().trim().min(1).max(60).optional(),
});

const listArticlesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Articles"],
  summary: "List published articles newest first",
  request: { query: articleListQuerySchema },
  responses: {
    200: {
      description: "Published article list with pagination",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              articles: z.array(pageSchema),
              pagination: paginationSchema,
            }),
          ),
        },
      },
    },
    500: errorResponses[500],
  },
});

app.openapi(listArticlesRoute, async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  return ok(c, await getPublicArticles(db, query));
});

const getArticleRoute = createRoute({
  method: "get",
  path: "/slug/{slug}",
  tags: ["Articles"],
  summary: "Get a published article by slug",
  request: {
    params: z.object({
      slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    }),
  },
  responses: {
    200: {
      description: "Published article detail",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({ article: pageSchema })),
        },
      },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getArticleRoute, async (c) => {
  const article = await getPublicArticleBySlug(
    c.get("db"),
    c.req.valid("param").slug,
  );
  if (!article) throw new NotFoundError("Article not found");
  return ok(c, { article });
});

export { app as articleRoutes };
