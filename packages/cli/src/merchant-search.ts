const SEARCH_STOP_WORDS = new Set([
  "a", "an", "are", "can", "did", "do", "for", "give", "how", "i", "is", "last", "low", "many", "me", "much", "my", "mine",
  "and", "have", "month", "need", "needing", "of", "on", "our", "please", "s", "show", "tell", "the", "this", "to", "total", "waiting", "we", "what", "which", "with",
]);

const MERCHANT_TERM_GROUPS = [
  ["today", "yesterday", "daily", "day", "week", "weekly"],
  ["sale", "sales", "sell", "sold", "revenue", "gmv", "activity", "summary"],
  ["order", "orders"],
  ["issue", "issues", "problem", "problems", "failure", "failures", "failed", "attention", "alert", "alerts", "recovery", "blocking"],
  ["health", "healthy", "readiness"],
  ["inventory", "inventories", "stock"],
  ["product", "products", "catalog", "merchandise"],
  ["customer", "customers", "buyer", "buyers", "shopper", "shoppers"],
  ["fulfill", "fulfil", "fulfillment", "fulfilment", "unfulfilled", "ship", "shipped", "shipping", "shipment", "shipments", "delivery", "deliveries"],
  ["payment", "payments", "gateway", "gateways"],
  ["method", "methods", "option", "options"],
  ["count", "counts", "number", "summary", "total"],
  ["pending", "unpaid", "overdue", "stuck"],
  ["refund", "refunds", "return", "returns"],
  ["recent", "latest", "new", "list", "activity", "summary"],
  ["operational", "health", "healthy", "ready", "readiness", "status", "store", "checkout", "configuration"],
] as const;

function normalizeWord(value: string): string {
  return value.toLocaleLowerCase();
}

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu)?.map(normalizeWord) ?? [];
}

function alternatives(term: string): readonly string[] {
  return MERCHANT_TERM_GROUPS.find((group) => group.includes(term as never)) ?? [term];
}

function storefrontWorkflowTargets(queryWords: Set<string>): string[] {
  const has = (...concepts: string[]) => concepts.some((concept) => queryWords.has(concept));
  if (has("start", "begin", "create") && has("cart", "basket", "checkout")) {
    return [
      "storefront.context.create",
      "storefront.cart.add",
      "storefront.delivery.set",
      "storefront.checkout.quote",
      "storefront.checkout.submit",
    ];
  }
  if (has("add", "put") && has("cart", "basket", "product", "item")) {
    return ["storefront.cart.add", "storefront.cart.get"];
  }
  if (has("buy", "purchase") && has("product", "item")) {
    return ["storefront.products.list", "storefront.cart.add", "storefront.checkout.submit"];
  }
  if (has("place", "submit") && has("order", "checkout")) {
    return ["storefront.checkout.submit"];
  }
  return [];
}

function merchantIntentTarget(queryWords: Set<string>): string | null {
  const has = (...concepts: string[]) => concepts.some((concept) => queryWords.has(concept));
  if (has("manual", "manually") && has("fulfill", "fulfil", "fulfillment", "fulfilment", "ship", "shipment")) {
    return "dashboard.orders.fulfill";
  }
  if (has("provider", "courier", "pathao", "steadfast") && has("create", "ship", "shipping", "shipment")) {
    return "dashboard.orders.create_shipment";
  }
  if (has("today", "yesterday", "daily", "day") && has(
    "sale", "sales", "sell", "sold", "revenue", "gmv", "order", "orders", "customer", "customers", "buyer", "buyers",
  )) return "dashboard.home.activity";
  if (has("sale", "sales", "sell", "sold", "revenue", "gmv")) return "dashboard.home.summary";
  if (has("product", "products", "catalog", "merchandise") && has("count", "counts", "number", "summary", "total", "many")) {
    return "dashboard.products.stats";
  }
  if (has("customer", "customers", "buyer", "buyers", "shopper", "shoppers") && has("count", "counts", "number", "summary", "total", "many")) {
    return "dashboard.home.summary";
  }
  if (has("refund", "refunds", "return", "returns") && has("need", "needing", "attention", "issue", "issues", "problem", "problems", "stuck")) {
    return "dashboard.orders.list";
  }
  if (has("order", "orders") && has("recent", "latest", "new", "pending", "unpaid", "overdue", "refund", "refunds", "return", "returns")) {
    return "dashboard.orders.list";
  }
  if (has("order", "orders") && has("fulfill", "fulfil", "fulfillment", "fulfilment", "unfulfilled", "ship", "shipped", "shipping", "delivery")) {
    return "dashboard.orders.list";
  }
  if (has("inventory", "stock") && has("low", "out", "issue", "issues", "problem", "problems", "alert", "alerts")) {
    return "dashboard.inventory_alerts.list";
  }
  if (has("inventory", "stock") && has("status", "summary", "count", "counts", "number", "total", "current")) {
    return "dashboard.inventory.list";
  }
  if (has("payment", "payments", "gateway", "gateways") && has("method", "methods", "option", "options", "enabled", "configured", "available")) {
    return "dashboard.payments.methods_get";
  }
  if (has("payment", "payments") && has("issue", "issues", "problem", "problems", "failed", "failure", "failures", "recovery")) {
    return "dashboard.orders.payment_recovery_list";
  }
  if (has("store", "checkout", "ready", "readiness") && has("health", "healthy", "ready", "readiness", "status")) {
    return "dashboard.checkout.readiness_get";
  }
  if (has("analytics") && has("health", "healthy", "status")) return "dashboard.analytics.health";
  if (has("customer", "customers", "buyer", "buyers", "shopper", "shoppers") && has("new", "recent", "latest", "list")) {
    return "dashboard.customers.list";
  }
  return null;
}

function intentBonus(searchableText: string, query: string): number {
  const queryWords = new Set(words(query));
  const workflowTargetIndex = storefrontWorkflowTargets(queryWords)
    .findIndex((operationId) => searchableText.toLocaleLowerCase().includes(operationId));
  if (workflowTargetIndex >= 0) return 120 - (workflowTargetIndex * 25);
  const target = merchantIntentTarget(queryWords);
  if (target && ["dashboard.orders.fulfill", "dashboard.orders.create_shipment"].includes(target)
    && searchableText.toLocaleLowerCase().split("\n", 1)[0] === target) return 120;
  return target && searchableText.toLocaleLowerCase().includes(target) ? 60 : 0;
}

export function prefersReadOnlyMerchantResults(query: string): boolean {
  const queryWords = new Set(words(query));
  if (["dashboard.orders.fulfill", "dashboard.orders.create_shipment"].includes(merchantIntentTarget(queryWords) ?? "")) return false;
  return ![
    "add", "apply", "begin", "buy", "cancel", "change", "checkout", "create", "delete", "make", "place",
    "publish", "purchase", "remove", "restore", "save", "set", "start", "submit", "update", "upload",
  ].some((word) => queryWords.has(word));
}

/** Keep this small matcher behavior-aligned with the dashboard/storefront MCP search. */
export function matchesMerchantOperationQuery(searchableText: string, query: string): boolean {
  return merchantOperationQueryScore(searchableText, query) !== null;
}

export function merchantOperationQueryScore(searchableText: string, query: string): number | null {
  const terms = words(query).filter((term) => !SEARCH_STOP_WORDS.has(term));
  if (terms.length === 0) return 0;
  const searchableWords = new Set(words(searchableText));
  const normalizedText = searchableText.toLocaleLowerCase();
  const canonicalBonus = intentBonus(searchableText, query);
  let score = normalizedText.includes(query.trim().toLocaleLowerCase()) ? 40 : 0;
  for (const term of terms) {
    if (searchableWords.has(term)) {
      score += 8;
      continue;
    }
    if (alternatives(term).some((candidate) => searchableWords.has(candidate) || normalizedText.includes(candidate))) {
      score += 3;
      continue;
    }
    if (canonicalBonus === 0) return null;
  }
  return score + canonicalBonus;
}
