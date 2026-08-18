import {
  AGENT_PRODUCT_CONSTRUCTION_RULES,
  type AgentWorkflowCard,
  type AgentWorkflowStepPolicies,
} from "./types";

const readPolicies: AgentWorkflowStepPolicies = {
  revision: "none",
  idempotency: "none",
  confirmation: "none",
  stopConditions: ["Read failure: stop."],
  nonInferenceRules: ["Missing stays unknown."],
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
  stopConditions: ["Conflict: stop; uncertainty: reread first."],
  nonInferenceRules: ["Use exact facts."],
};

export const OPTIONED_PRODUCT_WORKFLOW: AgentWorkflowCard = {
  id: "catalog.optioned-product.v1",
  surface: "dashboard",
  title: "Create an optioned product",
  summary: "Create and verify an optioned product.",
  examples: [
    "Create and verify a two-axis product.",
  ],
  tags: ["catalog", "media", "variants"],
  constructionRules: AGENT_PRODUCT_CONSTRUCTION_RULES,
  requiredFacts: [
    {
      id: "productSpec",
      title: "Product spec",
      description:
        "Exact name/description/price/slug, flags, SEO/canonicalPath/noIndex, sitemap/feed exclusions, condition.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule: "Do not invent copy, price, brand, condition, or flags.",
    },
    {
      id: "currency",
      title: "Currency",
      description: "Saved currency for all prices.",
      required: true,
      source: {
        kind: "operation",
        operationId: "dashboard.settings.currency_get",
        responsePointer: "/data/currencyCode",
      },
      nonInferenceRule: "Use saved currency; never convert.",
    },
    {
      id: "categoryId",
      title: "Category",
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
      nonInferenceRule: "Resolve exact ID; never guess.",
    },
    {
      id: "categoryCreateSpec",
      title: "Category spec",
      description:
        "Only if missing: exact name/slug/copy/SEO/canonical/discovery/image fields.",
      required: false,
      source: { kind: "merchant" },
      nonInferenceRule: "No spec means no category create.",
    },
    {
      id: "attributeSet",
      title: "Attributes",
      description:
        "{order,createOrder,byId}; values/create specs plus read or same-key captured IDs.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Only an active read or same-key create capture may set attributeId.",
    },
    {
      id: "mediaSet",
      title: "Media",
      description:
        "{order,importOrder,byId}: all keys, URL keys, resolved mediaId/alt/primary; 1-250 unique, one primary.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Never infer asset keys, count, order, role, or position.",
    },
    {
      id: "optionMatrix",
      title: "Matrix",
      description:
        "Ordered axes/values; complete SKU price/stock/mediaSet imageId rows.",
      required: true,
      source: { kind: "merchant" },
      nonInferenceRule:
        "Keep all rows/order; never infer imageId by label/position.",
    },
  ],
  phases: [
    {
      id: "resolve",
      surface: "dashboard",
      title: "Resolve",
      summary: "Read identities and policy.",
      dependsOn: [],
      stopConditions: ["Stop on ambiguity, collision, missing facts, or grants."],
      steps: [
        {
          id: "categories",
          title: "Categories",
          operationId: "dashboard.categories.form_options",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
        {
          id: "attributes",
          title: "Attributes",
          operationId: "dashboard.attributes.list_summaries",
          mutation: "read",
          condition: "Only requested attribute names.",
          input: {
            template: { query: { page: 1, limit: 20, search: null } },
            dependencies: [],
            defaults: [],
          },
          policies: readPolicies,
        },
        {
          id: "currency",
          title: "Currency",
          operationId: "dashboard.settings.currency_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
        {
          id: "seo",
          title: "Discovery",
          operationId: "dashboard.seo.settings_get",
          mutation: "read",
          input: { template: {}, dependencies: [], defaults: [] },
          policies: readPolicies,
        },
        {
          id: "productCollision",
          title: "Product collision",
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
            defaults: [],
          },
          policies: readPolicies,
        },
      ],
    },
    {
      id: "prepare",
      surface: "dashboard",
      title: "Prepare",
      summary: "Create approved prerequisites.",
      dependsOn: ["resolve"],
      stopConditions: ["Concurrent create: reread; never duplicate."],
      steps: [
        {
          id: "categoryCreate",
          title: "Category",
          operationId: "dashboard.categories.create",
          mutation: "create",
          condition: "Only when no exact reusable category exists.",
          input: {
            template: {
              body: {
                name: null,
                description: null,
                slug: null,
                metaTitle: null,
                metaDescription: null,
                canonicalPath: null,
                noIndex: null,
                excludeFromSitemap: null,
                image: null,
              },
            },
            dependencies: [],
            defaults: [],
            picks: [{
              factId: "categoryCreateSpec",
              templatePointer: "/body",
              keys: [
                "name",
                "description",
                "slug",
                "metaTitle",
                "metaDescription",
                "canonicalPath",
                "noIndex",
                "excludeFromSitemap",
                "image",
              ],
            }],
          },
          policies: createPolicies,
        },
        {
          id: "attributeCreate",
          title: "Attribute",
          operationId: "dashboard.attributes.create",
          mutation: "create",
          condition: "Skip when createOrder is empty; otherwise use its approved keys.",
          input: {
            template: { body: { name: null, slug: null, filterable: null, options: null } },
            dependencies: [],
            defaults: [],
          },
          repeat: {
            factId: "attributeSet",
            orderPointer: "/createOrder",
            itemMapPointer: "/byId",
            minItems: 1,
            maxItems: 90,
            bindings: [
              { templatePointer: "/body/name", itemPointer: "/name" },
              { templatePointer: "/body/slug", itemPointer: "/slug" },
              { templatePointer: "/body/filterable", itemPointer: "/filterable" },
              { templatePointer: "/body/options", itemPointer: "/options" },
            ],
            capture: { responsePointer: "/data/attribute/id", itemPointer: "/attributeId" },
          },
          policies: createPolicies,
        },
        {
          id: "discoveryUpdate",
          title: "Discovery",
          operationId: "dashboard.seo.settings_update",
          mutation: "partial",
          condition: "Only with store-wide approval.",
          input: { template: { body: { discovery: {} } }, dependencies: [], defaults: [] },
          policies: createPolicies,
        },
      ],
    },
    {
      id: "media",
      surface: "dashboard",
      title: "Media",
      summary: "Commit keyed assets.",
      dependsOn: ["resolve"],
      stopConditions: [
        "Stop on invalid, duplicate, inaccessible, or oversized media.",
      ],
      steps: [
        {
          id: "asset",
          title: "Asset",
          operationId: "dashboard.media.import_url",
          mutation: "create",
          condition:
            "Skip empty importOrder. Ready mediaId skips import; local files complete dashboard.media-upload and re-enter with mediaId.",
          input: {
            template: { body: { sourceUrl: null } },
            dependencies: [],
            defaults: [],
          },
          repeat: {
            factId: "mediaSet",
            orderPointer: "/importOrder",
            itemMapPointer: "/byId",
            minItems: 1,
            maxItems: 250,
            bindings: [{ templatePointer: "/body/sourceUrl", itemPointer: "/sourceUrl" }],
            capture: { responsePointer: "/data/file/id", itemPointer: "/mediaId" },
          },
          policies: {
            ...createPolicies,
            nonInferenceRules: [
              "Use exact facts.",
              "Capture mediaId only to the same key.",
            ],
          },
        },
      ],
    },
    {
      id: "create",
      surface: "dashboard",
      title: "Create",
      summary: "Submit one atomic product.",
      dependsOn: ["prepare", "media"],
      stopConditions: ["Stop on conflict; never fall back to per-SKU creation."],
      steps: [
        {
          id: "product",
          title: "Product",
          operationId: "dashboard.products.create",
          mutation: "create",
          condition:
            "Require every product field, active attribute ID, media association, axis, and SKU row.",
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
                media: [],
                attributes: [],
                optionMatrix: null,
              },
            },
            dependencies: [
              { templatePointer: "/body/categoryId", source: { kind: "fact", factId: "categoryId" } },
              { templatePointer: "/body/optionMatrix", source: { kind: "fact", factId: "optionMatrix" } },
            ],
            defaults: [],
            picks: [{
              factId: "productSpec",
              templatePointer: "/body",
              keys: [
                "name",
                "description",
                "price",
                "slug",
                "isActive",
                "freeDelivery",
                "metaTitle",
                "metaDescription",
                "canonicalPath",
                "noIndex",
                "excludeFromSitemap",
                "excludeFromProductFeed",
                "productCondition",
              ],
            }],
            materializations: [
              {
                factId: "mediaSet",
                templatePointer: "/body/media",
                orderPointer: "/order",
                itemMapPointer: "/byId",
                minItems: 1,
                maxItems: 250,
                keyField: "id",
                keys: ["mediaId", "altText", "isPrimary"],
              },
              {
                factId: "attributeSet",
                templatePointer: "/body/attributes",
                orderPointer: "/order",
                itemMapPointer: "/byId",
                minItems: 1,
                maxItems: 90,
                keys: ["attributeId", "value"],
              },
            ],
          },
          policies: {
            ...createPolicies,
            nonInferenceRules: [
              "Use exact facts.",
              "Variant imageId must equal a mediaSet pmed key; never use position.",
            ],
          },
        },
      ],
    },
    {
      id: "publish",
      surface: "dashboard",
      title: "Publish",
      summary: "Read readiness and revision, then publish.",
      dependsOn: ["create"],
      stopConditions: ["Readiness/revision failure: stop."],
      steps: [
        {
          id: "category",
          title: "Category",
          operationId: "dashboard.categories.get_section",
          mutation: "read",
          input: {
            template: { path: { id: null, section: "summary" } },
            dependencies: [{ templatePointer: "/path/id", source: { kind: "fact", factId: "categoryId" } }],
            defaults: [],
          },
          policies: readPolicies,
        },
        {
          id: "readiness",
          title: "Readiness",
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
          title: "Status",
          operationId: "dashboard.categories.set_status",
          mutation: "lifecycle",
          condition: "Only if ready and not published.",
          input: {
            template: { path: { id: null }, body: { expectedRevision: null, status: "published" } },
            dependencies: [
              { templatePointer: "/path/id", source: { kind: "fact", factId: "categoryId" } },
              {
                templatePointer: "/body/expectedRevision",
                source: { kind: "step", phaseId: "publish", stepId: "category", responsePointer: "/data/category/revision" },
              },
            ],
            defaults: [],
          },
          policies: {
            ...createPolicies,
            revision: "required",
            stopConditions: ["Conflict: reread summary/readiness; no stale retry."],
          },
        },
      ],
    },
    {
      id: "dashboardVerify",
      surface: "dashboard",
      title: "Admin verify",
      summary: "Read admin evidence.",
      dependsOn: ["create", "publish"],
      stopConditions: [
        "Stop on product/discovery drift.",
        "Preview proves rows only; not sitemap membership, cache propagation, or provider acceptance.",
        "Oversize preview: report row unverified; do not claim feed parity.",
      ],
      steps: [
        {
          id: "sections",
          title: "Sections",
          operationId: "dashboard.products.get_section",
          mutation: "read",
          condition: "Read base, text, media, attributes, info, options, variants.",
          input: {
            template: { path: { id: null, section: null }, query: { offset: 0, limit: 10 } },
            dependencies: [
              {
                templatePointer: "/path/id",
                source: { kind: "step", phaseId: "create", stepId: "product", responsePointer: "/data/id" },
              },
            ],
            defaults: [],
          },
          policies: readPolicies,
        },
        {
          id: "feed",
          title: "Feed",
          operationId: "dashboard.seo.feed_row_preview",
          mutation: "read",
          condition: "Page cursor to end.",
          input: {
            template: { path: { productId: null }, query: { limit: 10 } },
            dependencies: [{
              templatePointer: "/path/productId",
              source: { kind: "step", phaseId: "create", stepId: "product", responsePointer: "/data/id" },
            }],
            defaults: [],
          },
          policies: readPolicies,
        },
        {
          id: "probe",
          title: "Probe",
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
      title: "Buyer verify",
      summary: "Compare buyer SKU truth.",
      dependsOn: ["dashboardVerify"],
      stopConditions: ["Buyer-visible mismatch: stop."],
      steps: [
        {
          id: "sections",
          title: "Sections",
          operationId: "storefront.products.get_section",
          mutation: "read",
          condition: "Read summary, media, options, values, bounded variants.",
          input: {
            template: { path: { slug: null, section: null }, query: { offset: 0, limit: 10 } },
            dependencies: [
              { templatePointer: "/path/slug", source: { kind: "fact", factId: "productSpec", factPointer: "/slug" } },
            ],
            defaults: [],
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
      operationId: "dashboard.seo.feed_row_preview",
      responsePointers: ["/data/entries", "/data/pagination", "/data/semantics"],
      proves: ["Exact emitted row or omission reason; oversize is unverified."],
      bounds: { maxCalls: 25, maxItems: 250, maxResponseBytes: 47_104 },
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
      proves: ["Buyer SKU price, exact image, availability; excludes sitemap/feed membership."],
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
            defaults: [],
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
