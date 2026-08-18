import {
  AGENT_PRODUCT_CONSTRUCTION_RULES,
  type AgentWorkflowCard,
  type AgentWorkflowStepPolicies,
} from "./types";

const readPolicies: AgentWorkflowStepPolicies = {
  revision: "none",
  idempotency: "none",
  confirmation: "none",
  stopConditions: ["Stop on auth/read failure."],
  nonInferenceRules: ["Treat missing data as unknown."],
};

const dailyReadPolicies: AgentWorkflowStepPolicies = {
  revision: "none",
  idempotency: "none",
  confirmation: "none",
  stopConditions: ["Stop on read failure."],
  nonInferenceRules: ["Missing is unknown."],
};

const createPolicies: AgentWorkflowStepPolicies = {
  revision: "none",
  idempotency: "none",
  confirmation: "required",
  stopConditions: ["On conflict or uncertain write, stop and reread."],
  nonInferenceRules: ["Use resolved or merchant facts."],
};

export const OPTIONED_PRODUCT_WORKFLOW: AgentWorkflowCard = {
  id: "catalog.optioned-product.v1",
  surface: "dashboard",
  title: "Create an optioned product",
  summary: "Resolve, atomically create, publish, and verify exact SKU truth.",
  examples: [
    "Create a two-axis product and verify exact SKU, media, stock, and discovery truth.",
  ],
  tags: ["catalog", "media", "variants"],
  constructionRules: AGENT_PRODUCT_CONSTRUCTION_RULES,
  requiredFacts: [
    {
      id: "productSpec",
      title: "Product",
      description: "Name/slug, rich text, price, SEO, condition, visibility.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule: "Never invent claims, brand, price, condition, or copy.",
    },
    {
      id: "categoryId",
      title: "Category ID",
      description: "Existing category ID or conditional-create result.",
      required: true,
      source: {
        kind: "operation",
        operationId: "dashboard.categories.form_options",
        responsePointer: "/data/categories",
        alternatives: [
          { operationId: "dashboard.categories.create", responsePointer: "/data/id" },
        ],
      },
      nonInferenceRule: "Resolve by name; never guess or substitute an ID.",
    },
    {
      id: "attributeAssignments",
      title: "Attributes",
      description: "Active IDs and truthful merchant values.",
      required: true,
      source: {
        kind: "operation",
        operationId: "dashboard.attributes.list_summaries",
        responsePointer: "/data/attributes",
      },
      nonInferenceRule: "Never duplicate or fabricate attributes.",
    },
    {
      id: "mediaSet",
      title: "Media set",
      description:
        "{order:[pmed...],byId:{pmed:{mediaId|sourceUrl,altText,isPrimary}}}; 1-250 unique assets, one primary.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Use exact keys/sources; never infer count, order, role, or position.",
    },
    {
      id: "optionMatrix",
      title: "Option matrix",
      description:
        "Ordered axes/values; complete SKU price/stock/mediaSet imageId rows.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Never add, omit, collapse, or reorder combinations, or infer imageId by label/position.",
    },
  ],
  phases: [
    {
      id: "resolve",
      surface: "dashboard",
      title: "Resolve identities and policy",
      summary: "Use bounded reads once before constructing any mutation.",
      dependsOn: [],
      stopConditions: ["Stop on ambiguity, collision, missing facts, or grants."],
      steps: [
        {
          id: "categories",
          title: "Resolve category options",
          operationId: "dashboard.categories.form_options",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
        {
          id: "attributes",
          title: "Resolve attribute summaries",
          operationId: "dashboard.attributes.list_summaries",
          mutation: "read",
          condition: "Repeat only for requested attribute names.",
          input: {
            template: { query: { page: 1, limit: 20, search: null } },
            dependencies: [],
            defaults: [
              { templatePointer: "/query/page", value: 1 },
              { templatePointer: "/query/limit", value: 20 },
            ],
          },
          policies: readPolicies,
        },
        {
          id: "seo",
          title: "Read discovery settings",
          operationId: "dashboard.seo.settings_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
        {
          id: "productCollision",
          title: "Check product slug and name",
          operationId: "dashboard.products.list_summaries",
          mutation: "read",
          input: {
            template: { query: { page: 1, limit: 10, search: null } },
            dependencies: [
              {
                templatePointer: "/query/search",
                source: { kind: "fact", factId: "productSpec", factPointer: "/name" },
              },
            ],
            defaults: [
              { templatePointer: "/query/page", value: 1 },
              { templatePointer: "/query/limit", value: 10 },
            ],
          },
          policies: readPolicies,
        },
        {
          id: "skuCollision",
          title: "Check active SKU namespace",
          operationId: "dashboard.inventory.list",
          mutation: "read",
          input: {
            template: { query: { section: "variants", search: null, status: "all", page: 1, limit: 100 } },
            dependencies: [
              {
                templatePointer: "/query/search",
                source: { kind: "fact", factId: "optionMatrix", factPointer: "/skuPrefix" },
              },
            ],
            defaults: [
              { templatePointer: "/query/page", value: 1 },
              { templatePointer: "/query/limit", value: 100 },
            ],
          },
          policies: readPolicies,
        },
      ],
    },
    {
      id: "prepare",
      surface: "dashboard",
      title: "Create missing prerequisites",
      summary: "Create missing prerequisites and only approved discovery fields.",
      dependsOn: ["resolve"],
      stopConditions: ["On concurrent create, reread; never duplicate."],
      steps: [
        {
          id: "categoryCreate",
          title: "Create draft category",
          operationId: "dashboard.categories.create",
          mutation: "create",
          condition: "Only when no unambiguous reusable category exists.",
          input: {
            template: { body: { name: null, slug: null, description: null, metaTitle: null, metaDescription: null, image: null } },
            dependencies: [],
            defaults: [],
          },
          policies: createPolicies,
        },
        {
          id: "attributeCreate",
          title: "Create missing attribute",
          operationId: "dashboard.attributes.create",
          mutation: "create",
          condition: "Repeat for each approved missing attribute.",
          input: {
            template: { body: { name: null, slug: null, filterable: true, options: [] } },
            dependencies: [],
            defaults: [{ templatePointer: "/body/filterable", value: true }],
          },
          policies: createPolicies,
        },
        {
          id: "discoveryUpdate",
          title: "Enable requested discovery fields",
          operationId: "dashboard.seo.settings_update",
          mutation: "partial",
          condition: "Only after explicit store-wide approval.",
          input: { template: { body: { discovery: {} } }, dependencies: [], defaults: [] },
          policies: createPolicies,
        },
      ],
    },
    {
      id: "media",
      surface: "dashboard",
      title: "Commit media",
      summary: "Commit assets with keyed IDs.",
      dependsOn: ["resolve"],
      stopConditions: [
        "Stop on invalid, inaccessible, oversized, duplicate, or ambiguous media.",
      ],
      steps: [
        {
          id: "asset",
          title: "Commit one declared asset",
          operationId: "dashboard.media.import_url",
          mutation: "create",
          condition:
            "Skip ready mediaId; local files must complete dashboard.media-upload and re-enter as ready.",
          input: {
            template: { body: { sourceUrl: null } },
            dependencies: [],
            defaults: [],
          },
          repeat: {
            factId: "mediaSet",
            orderPointer: "/order",
            itemMapPointer: "/byId",
            minItems: 1,
            maxItems: 250,
            bindings: [{ templatePointer: "/body/sourceUrl", itemPointer: "/sourceUrl" }],
            capture: { responsePointer: "/data/file/id", itemPointer: "/mediaId" },
          },
          policies: {
            ...createPolicies,
            nonInferenceRules: [
              "Use resolved or merchant facts.",
              "Never cross-assign captured media IDs.",
            ],
          },
        },
      ],
    },
    {
      id: "create",
      surface: "dashboard",
      title: "Create atomically",
      summary: "Submit media, attributes, axes, and all SKUs atomically.",
      dependsOn: ["prepare", "media"],
      stopConditions: ["Stop on conflict; never fall back to per-SKU creation."],
      steps: [
        {
          id: "product",
          title: "Create atomic optioned product",
          operationId: "dashboard.products.create",
          mutation: "create",
          condition:
            "Materialize body.media from every ordered mediaSet item using exact pmed key/mediaId; require 1-250 unique assets, one primary.",
          input: {
            template: {
              body: {
                name: null,
                description: null,
                price: null,
                categoryId: null,
                isActive: true,
                freeDelivery: false,
                metaTitle: null,
                metaDescription: null,
                canonicalPath: null,
                noIndex: false,
                excludeFromSitemap: false,
                excludeFromProductFeed: false,
                productCondition: null,
                slug: null,
                media: null,
                attributes: null,
                optionMatrix: null,
              },
            },
            dependencies: [
              { templatePointer: "/body/name", source: { kind: "fact", factId: "productSpec", factPointer: "/name" } },
              { templatePointer: "/body/slug", source: { kind: "fact", factId: "productSpec", factPointer: "/slug" } },
              { templatePointer: "/body/categoryId", source: { kind: "fact", factId: "categoryId" } },
              { templatePointer: "/body/attributes", source: { kind: "fact", factId: "attributeAssignments" } },
              { templatePointer: "/body/optionMatrix", source: { kind: "fact", factId: "optionMatrix" } },
            ],
            defaults: [
              { templatePointer: "/body/isActive", value: true },
              { templatePointer: "/body/noIndex", value: false },
              { templatePointer: "/body/excludeFromSitemap", value: false },
              { templatePointer: "/body/excludeFromProductFeed", value: false },
            ],
          },
          policies: {
            ...createPolicies,
            nonInferenceRules: [
              "Use resolved or merchant facts.",
              "Every variant imageId must equal a mediaSet pmed key; never map by position.",
            ],
          },
        },
      ],
    },
    {
      id: "publish",
      surface: "dashboard",
      title: "Publish eligible category",
      summary: "Prove readiness, then publish with current revision.",
      dependsOn: ["create"],
      stopConditions: ["Stop on readiness blocker or revision conflict."],
      steps: [
        {
          id: "category",
          title: "Read fresh category revision",
          operationId: "dashboard.categories.get_section",
          mutation: "read",
          input: {
            template: { path: { id: null, section: "summary" } },
            dependencies: [{ templatePointer: "/path/id", source: { kind: "fact", factId: "categoryId" } }],
            defaults: [{ templatePointer: "/path/section", value: "summary" }],
          },
          policies: readPolicies,
        },
        {
          id: "readiness",
          title: "Read category publish readiness",
          operationId: "dashboard.categories.publish_readiness",
          mutation: "read",
          input: {
            template: { path: { id: null } },
            dependencies: [{ templatePointer: "/path/id", source: { kind: "fact", factId: "categoryId" } }],
            defaults: [],
          },
          policies: readPolicies,
        },
        {
          id: "status",
          title: "Publish category with CAS",
          operationId: "dashboard.categories.set_status",
          mutation: "lifecycle",
          condition: "Only if not published and ready.",
          input: {
            template: { path: { id: null }, body: { expectedRevision: null, status: "published" } },
            dependencies: [
              { templatePointer: "/path/id", source: { kind: "fact", factId: "categoryId" } },
              {
                templatePointer: "/body/expectedRevision",
                source: { kind: "step", phaseId: "publish", stepId: "category", responsePointer: "/data/category/revision" },
              },
            ],
            defaults: [{ templatePointer: "/body/status", value: "published" }],
          },
          policies: {
            ...createPolicies,
            revision: "required",
            stopConditions: ["On conflict, reread summary/readiness; never retry stale."],
          },
        },
      ],
    },
    {
      id: "dashboardVerify",
      surface: "dashboard",
      title: "Verify dashboard truth",
      summary: "Read composition and bounded discovery evidence.",
      dependsOn: ["create", "publish"],
      stopConditions: [
        "Stop on SKU/image/stock drift or discovery failure.",
        "No bounded product/SKU feed-row read exists; do not claim emitted price/image/availability.",
      ],
      steps: [
        {
          id: "sections",
          title: "Read bounded product sections",
          operationId: "dashboard.products.get_section",
          mutation: "read",
          condition: "Read base, text, media, attributes, info, options, and variants.",
          input: {
            template: { path: { id: null, section: null }, query: { offset: 0, limit: 10 } },
            dependencies: [
              {
                templatePointer: "/path/id",
                source: { kind: "step", phaseId: "create", stepId: "product", responsePointer: "/data/id" },
              },
            ],
            defaults: [
              { templatePointer: "/query/offset", value: 0 },
              { templatePointer: "/query/limit", value: 10 },
            ],
          },
          policies: readPolicies,
        },
        {
          id: "feed",
          title: "Read bounded feed diagnostics",
          operationId: "dashboard.seo.feed_diagnostics",
          mutation: "read",
          input: { template: { query: { scanLimit: 500, sampleLimit: 10 } }, dependencies: [], defaults: [{ templatePointer: "/query/scanLimit", value: 500 }, { templatePointer: "/query/sampleLimit", value: 10 }] },
          policies: readPolicies,
        },
        {
          id: "probe",
          title: "Probe public discovery resources",
          operationId: "dashboard.seo.live_probe",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
      ],
    },
    {
      id: "storefrontVerify",
      surface: "storefront",
      title: "Verify buyer SKU truth",
      summary: "Compare buyer options, prices, images, and availability.",
      dependsOn: ["dashboardVerify"],
      stopConditions: ["Stop on missing or mismatched buyer-visible facts."],
      steps: [
        {
          id: "sections",
          title: "Read storefront product sections",
          operationId: "storefront.products.get_section",
          mutation: "read",
          condition: "Read summary, media, options, values, and bounded variants.",
          input: {
            template: { path: { slug: null, section: null }, query: { offset: 0, limit: 10 } },
            dependencies: [
              { templatePointer: "/path/slug", source: { kind: "fact", factId: "productSpec", factPointer: "/slug" } },
            ],
            defaults: [
              { templatePointer: "/query/offset", value: 0 },
              { templatePointer: "/query/limit", value: 10 },
            ],
          },
          policies: readPolicies,
        },
      ],
    },
  ],
  verification: [
    {
      id: "composition",
      surface: "dashboard",
      operationId: "dashboard.products.get_section",
      responsePointers: ["/data/aggregateRevision", "/data/items", "/data/total"],
      proves: ["Exact media, attributes, axes, SKUs, prices, and stock."],
      bounds: { maxCalls: 50, maxItems: 500, maxResponseBytes: 65_536 },
    },
    {
      id: "feed",
      surface: "dashboard",
      operationId: "dashboard.seo.feed_diagnostics",
      responsePointers: ["/data/policy", "/data/totals", "/data/reasons"],
      proves: ["Feed policy, eligibility totals, and sampled exclusions only."],
      bounds: { maxCalls: 1, maxItems: 500, maxResponseBytes: 65_536 },
    },
    {
      id: "discovery",
      surface: "dashboard",
      operationId: "dashboard.seo.live_probe",
      responsePointers: ["/data/ok", "/data/resources"],
      proves: ["Sitemap/feed health, bounded counts, and absolute links only."],
      bounds: { maxCalls: 1, maxItems: 12, maxResponseBytes: 65_536 },
    },
    {
      id: "buyer",
      surface: "storefront",
      operationId: "storefront.products.get_section",
      responsePointers: ["/data/product", "/data/items"],
      proves: ["Buyer SKU price, exact image, and availability band; excludes feed rows."],
      bounds: { maxCalls: 20, maxItems: 150, maxResponseBytes: 61_440 },
    },
  ],
};

export const DAILY_OPERATING_SNAPSHOT_WORKFLOW: AgentWorkflowCard = {
  id: "operations.daily-snapshot.v1",
  surface: "dashboard",
  title: "Daily snapshot",
  summary: "Report booked activity, backlogs, and checkout readiness.",
  examples: [
    "Read booked revenue, orders, fulfillment, stock/recovery work, and checkout readiness.",
  ],
  tags: ["daily", "operations", "readiness"],
  requiredFacts: [
    {
      id: "days",
      title: "Merchant-day window",
      description: "Use 1 today; use 2 and select the earlier key yesterday.",
      required: true,
      defaultValue: 1,
      source: { kind: "constant", value: 1 },
      nonInferenceRule: "Keep Asia/Dhaka keys; ignore host timezone.",
    },
    {
      id: "currency",
      title: "Currency",
      description: "Use saved currency settings.",
      required: true,
      source: { kind: "operation", operationId: "dashboard.settings.currency_get", responsePointer: "/data/currencyCode" },
      nonInferenceRule: "Never guess currency.",
    },
  ],
  phases: [
    {
      id: "activity",
      surface: "dashboard",
      title: "Activity and queues",
      summary: "Merchant-day activity, currency, and queues.",
      dependsOn: [],
      stopConditions: ["Use pagination and Asia/Dhaka dates."],
      steps: [
        {
          id: "daily",
          title: "Activity",
          operationId: "dashboard.home.activity",
          mutation: "read",
          input: {
            template: { query: { days: 1 } },
            dependencies: [{ templatePointer: "/query/days", source: { kind: "fact", factId: "days" } }],
            defaults: [{ templatePointer: "/query/days", value: 1 }],
          },
          output: {
            selectors: [{
              pointer: "/data/dailyActivityData",
              alias: "activity",
              maxItems: 2,
              fields: [
                { pointer: "/date", alias: "date" },
                { pointer: "/orders", alias: "orders" },
                { pointer: "/revenue", alias: "bookedRevenue" },
                { pointer: "/newCustomers", alias: "newCustomers" },
              ],
            }],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "currency",
          title: "Currency",
          operationId: "dashboard.settings.currency_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          output: {
            selectors: [
              { pointer: "/data/currencyCode", alias: "currencyCode" },
              { pointer: "/data/currencySymbol", alias: "currencySymbol" },
            ],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "fulfillment",
          title: "Fulfillment",
          operationId: "dashboard.orders.list",
          mutation: "read",
          input: {
            template: {
              query: {
                page: 1,
                limit: 10,
                statusGroup: "open",
                fulfillmentStatus: "pending",
                sort: "createdAt",
                order: "desc",
              },
            },
            dependencies: [],
            defaults: [],
          },
          output: {
            selectors: [
              {
                pointer: "/data/orders",
                alias: "orderQueue",
                maxItems: 10,
                fields: [
                  { pointer: "/id", alias: "id" },
                  { pointer: "/totalAmount", alias: "totalAmount" },
                  { pointer: "/status", alias: "status" },
                  { pointer: "/paymentStatus", alias: "paymentStatus" },
                  { pointer: "/paymentMethod", alias: "paymentMethod" },
                  { pointer: "/fulfillmentStatus", alias: "fulfillmentStatus" },
                  { pointer: "/createdAt", alias: "createdAt" },
                  { pointer: "/itemCount", alias: "itemCount" },
                  { pointer: "/totalQuantity", alias: "totalQuantity" },
                ],
              },
              {
                pointer: "/data/pagination",
                alias: "pagination",
                fields: [
                  { pointer: "/page", alias: "page" },
                  { pointer: "/limit", alias: "limit" },
                  { pointer: "/total", alias: "total" },
                  { pointer: "/totalPages", alias: "totalPages" },
                ],
              },
            ],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "paymentRecovery",
          title: "Recovery",
          operationId: "dashboard.orders.payment_recovery_list",
          mutation: "read",
          input: {
            template: { query: { page: 1, limit: 1, state: "recoverable" } },
            dependencies: [],
            defaults: [],
          },
          output: {
            selectors: [
              { pointer: "/data/pagination/total", alias: "total" },
            ],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "paymentNeedsAttention",
          title: "Attention total",
          operationId: "dashboard.orders.payment_recovery_list",
          mutation: "read",
          input: {
            template: { query: { page: 1, limit: 1, state: "needs_attention" } },
            dependencies: [],
            defaults: [],
          },
          output: {
            selectors: [
              { pointer: "/data/pagination/total", alias: "total" },
            ],
          },
          policies: dailyReadPolicies,
        },
      ],
    },
    {
      id: "readiness",
      surface: "dashboard",
      title: "Readiness",
      summary: "Read saved, active, and buyer-usable checkout facts.",
      dependsOn: ["activity"],
      stopConditions: ["Missing readiness is unknown."],
      steps: [
        {
          id: "alerts",
          title: "Alerts",
          operationId: "dashboard.inventory_alerts.list",
          mutation: "read",
          input: { template: { query: { status: "active" } }, dependencies: [], defaults: [] },
          output: {
            selectors: [{
              pointer: "/data/alerts",
              alias: "inventoryAlerts",
              maxItems: 20,
              fields: [
                { pointer: "/productId", alias: "productId" },
                { pointer: "/productName", alias: "productName" },
                { pointer: "/variantId", alias: "variantId" },
                { pointer: "/variantSku", alias: "sku" },
                { pointer: "/variantLabel", alias: "variant" },
                { pointer: "/currentQty", alias: "quantity" },
                { pointer: "/threshold", alias: "threshold" },
                { pointer: "/alertStatus", alias: "status" },
              ],
            }],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "checkout",
          title: "Checkout",
          operationId: "dashboard.checkout.readiness_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          output: {
            selectors: [
              { pointer: "/data/ready", alias: "ready" },
              {
                pointer: "/data/hasActiveShippingMethod",
                alias: "hasActiveShippingMethod",
              },
              {
                pointer: "/data/hasActiveDeliveryHierarchy",
                alias: "hasActiveDeliveryHierarchy",
              },
              {
                pointer: "/data/customerSignInRequired",
                alias: "customerSignInRequired",
              },
              {
                pointer: "/data/hasUsableCustomerSignIn",
                alias: "hasUsableCustomerSignIn",
              },
              { pointer: "/data/issues", alias: "issues", maxItems: 20 },
            ],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "payments",
          title: "Payments",
          operationId: "dashboard.payments.methods_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          output: {
            selectors: [
              {
                pointer: "/data/enabledMethods",
                alias: "enabledMethods",
                maxItems: 4,
              },
              {
                pointer: "/data/activeMethods",
                alias: "activeMethods",
                maxItems: 4,
              },
              { pointer: "/data/defaultMethod", alias: "defaultMethod" },
              { pointer: "/data/activeDefaultMethod", alias: "activeDefaultMethod" },
              {
                pointer: "/data/gatewayStatus",
                alias: "gatewayStatus",
                fields: [
                  { pointer: "/stripe/configured", alias: "stripeConfigured" },
                  { pointer: "/stripe/usable", alias: "stripeUsable" },
                  { pointer: "/stripe/checkoutVisible", alias: "stripeVisible" },
                  { pointer: "/sslcommerz/configured", alias: "sslConfigured" },
                  { pointer: "/sslcommerz/usable", alias: "sslUsable" },
                  { pointer: "/sslcommerz/checkoutVisible", alias: "sslVisible" },
                  { pointer: "/polar/configured", alias: "polarConfigured" },
                  { pointer: "/polar/usable", alias: "polarUsable" },
                  { pointer: "/polar/checkoutVisible", alias: "polarVisible" },
                  { pointer: "/cod/configured", alias: "codConfigured" },
                  { pointer: "/cod/usable", alias: "codUsable" },
                  { pointer: "/cod/checkoutVisible", alias: "codVisible" },
                ],
              },
            ],
          },
          policies: dailyReadPolicies,
        },
        {
          id: "delivery",
          title: "Shipping",
          operationId: "dashboard.shipping_methods.list",
          mutation: "read",
          input: {
            template: { query: { page: 1, limit: 100, sort: "sortOrder", order: "asc" } },
            dependencies: [],
            defaults: [],
          },
          output: {
            selectors: [
              {
                pointer: "/data/shippingMethods",
                alias: "shippingMethods",
                maxItems: 100,
                fields: [
                  { pointer: "/id", alias: "id" },
                  { pointer: "/name", alias: "name" },
                  { pointer: "/fee", alias: "fee" },
                  { pointer: "/isActive", alias: "isActive" },
                  { pointer: "/sortOrder", alias: "sortOrder" },
                ],
              },
              {
                pointer: "/data/pagination",
                alias: "pagination",
                fields: [
                  { pointer: "/page", alias: "page" },
                  { pointer: "/limit", alias: "limit" },
                  { pointer: "/total", alias: "total" },
                  { pointer: "/totalPages", alias: "totalPages" },
                ],
              },
            ],
          },
          policies: dailyReadPolicies,
        },
      ],
    },
  ],
  verification: [
    {
      id: "activity",
      surface: "dashboard",
      operationId: "dashboard.home.activity",
      responsePointers: ["/data"],
      proves: ["Merchant-day booked gross; no collected cash or settlement."],
      bounds: { maxCalls: 1, maxItems: 2, maxResponseBytes: 32_768 },
    },
    {
      id: "fulfillment",
      surface: "dashboard",
      operationId: "dashboard.orders.list",
      responsePointers: ["/data/orders", "/data/pagination"],
      proves: ["Bounded open/pending queue with pagination."],
      bounds: { maxCalls: 1, maxItems: 10, maxResponseBytes: 65_536 },
    },
    {
      id: "paymentRecovery",
      surface: "dashboard",
      operationId: "dashboard.orders.payment_recovery_list",
      responsePointers: ["/data/pagination/total"],
      proves: ["Two current count-only recovery snapshots; no order rows or PII."],
      bounds: { maxCalls: 2, maxItems: 1, maxResponseBytes: 65_536 },
    },
    {
      id: "readiness",
      surface: "dashboard",
      operationId: "dashboard.checkout.readiness_get",
      responsePointers: ["/data"],
      proves: ["Checkout payment and delivery blockers."],
      bounds: { maxCalls: 1, maxItems: 20, maxResponseBytes: 65_536 },
    },
    {
      id: "payment",
      surface: "dashboard",
      operationId: "dashboard.payments.methods_get",
      responsePointers: ["/data/enabledMethods", "/data/gatewayStatus"],
      proves: ["Saved versus usable and checkout-visible methods."],
      bounds: { maxCalls: 1, maxItems: 4, maxResponseBytes: 65_536 },
    },
    {
      id: "delivery",
      surface: "dashboard",
      operationId: "dashboard.shipping_methods.list",
      responsePointers: ["/data/shippingMethods", "/data/pagination"],
      proves: ["Bounded saved methods with active flags."],
      bounds: { maxCalls: 1, maxItems: 100, maxResponseBytes: 65_536 },
    },
  ],
};

export const CURATED_AGENT_WORKFLOW_CARDS: readonly AgentWorkflowCard[] = [
  OPTIONED_PRODUCT_WORKFLOW,
  DAILY_OPERATING_SNAPSHOT_WORKFLOW,
];
