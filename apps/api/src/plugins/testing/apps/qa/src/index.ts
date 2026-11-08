// acme.qa: product questions and answers, built only on the stable app API.
//
// - Objects: `questions`, one record per question, keyed by the product it
//   asks about (an index led by `product`), public on the storefront once
//   staff answer it (`status: "published"`).
// - Storefront: a `product.below` component that declares one read bound to
//   the page's product (`where: { product: { resource: "product" } }`): each
//   product page shows its own answered questions, read with the product
//   template's part in the page's one batch. An answer to one product's
//   question refreshes that product's page only.
// - Public route `ask` (a buyer's question, kept as a draft) and admin route
//   `answer` (publishes it with its answer).

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput, type PluginRouteRequest } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.qa",
  name: "Product Q&A",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers ask about a product; your answers show on that product's page.",
  author: { name: "Acme" },
  categories: ["marketing"],
  routes: {
    admin: [{ name: "answer", methods: ["POST"], description: "Answers a question and shows it on its product's page." }],
    public: [{ name: "ask", methods: ["POST"], description: "Asks a question about a product." }],
  },
  objects: {
    questions: {
      name: "Questions",
      storefront: true,
      fields: [
        { key: "product", name: "Product", type: "product_reference", required: true },
        { key: "question", name: "Question", type: "single_line_text", required: true },
        { key: "answer", name: "Answer", type: "multi_line_text" },
      ],
      display: "question",
      indexes: ["product"],
    },
  },
  storefront: {
    // Buyers ask through the store's own address (`/apps/acme.qa/ask`).
    proxy: true,
    components: [{
      type: "questions", name: "Questions and answers", targets: ["product.below"],
      settings: [{ key: "heading", label: "Heading", type: "text", default: "Questions and answers", maxLength: 80 }],
      reads: [{ object: "questions", where: { product: { resource: "product" } }, limit: 10 }],
    }],
  },
} satisfies PluginManifestInput;

const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^q_[a-f0-9-]{36}$/;

const questions = (ctx: PluginContext) => ctx.objects.questions!;

function field(request: PluginRouteRequest, name: string): string {
  const body = (typeof request.body === "object" && request.body !== null ? request.body : {}) as Record<string, unknown>;
  const value = body[name];
  return typeof value === "string" ? value.trim() : "";
}

export default definePlugin({
  manifest,
  routes: {
    public: {
      // A question waits as a draft: the storefront shows only published records.
      ask: async (request, ctx) => {
        const product = field(request, "productId");
        const question = field(request, "question").slice(0, 300);
        if (!PRODUCT_ID.test(product) || !question) return { status: 422, body: { message: "Ask a question about a product." } };
        const id = `q_${crypto.randomUUID()}`;
        await questions(ctx).put(id, { product, question }, { status: "draft" });
        return { body: { id, message: "Thanks: the answer will show on the product page." } };
      },
    },
    admin: {
      answer: async (request, ctx) => {
        const id = field(request, "id");
        const answer = field(request, "answer").slice(0, 2000);
        const existing = QUESTION_ID.test(id) ? await questions(ctx).get(id) : null;
        if (!existing || !answer) return { status: 422, body: { message: "Choose a question and write its answer." } };
        await questions(ctx).put(id, { ...existing, answer }, { status: "published" });
        return { body: { id, published: true } };
      },
    },
  },
});
