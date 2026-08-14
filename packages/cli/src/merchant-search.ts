const SEARCH_STOP_WORDS = new Set([
  "a", "an", "are", "can", "did", "do", "for", "give", "how", "i", "is", "last", "low", "many", "me", "much", "my", "mine",
  "month", "need", "needing", "of", "on", "our", "please", "s", "show", "tell", "the", "this", "to", "total", "waiting", "we", "what", "which", "with",
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

function intentBonus(searchableText: string, query: string): number {
  const queryWords = new Set(words(query));
  const has = (...concepts: string[]) => concepts.some((concept) => queryWords.has(concept));
  const target = has("sale", "sales", "sell", "sold", "revenue", "gmv") && has("today", "yesterday", "daily", "day")
    ? "dashboard.home.activity"
    : has("sale", "sales", "sell", "sold", "revenue", "gmv")
      ? "dashboard.home.summary"
      : has("order", "orders") && has("fulfill", "fulfil", "fulfillment", "fulfilment", "unfulfilled", "ship", "shipped", "shipping", "delivery")
        ? "dashboard.orders.list"
        : has("inventory", "stock") && has("low", "out", "issue", "issues", "problem", "problems", "alert", "alerts")
          ? "dashboard.inventory_alerts.list"
          : has("payment", "payments") && has("issue", "issues", "problem", "problems", "failed", "failure", "failures", "recovery")
            ? "dashboard.orders.payment_recovery_list"
            : has("store", "checkout", "ready", "readiness") && has("health", "healthy", "ready", "readiness", "status")
              ? "dashboard.checkout.readiness_get"
              : has("analytics") && has("health", "healthy", "status")
                ? "dashboard.analytics.health"
                : has("customer", "customers", "buyer", "buyers", "shopper", "shoppers") && has("new", "recent", "latest", "list")
                  ? "dashboard.customers.list"
                  : null;
  return target && searchableText.toLocaleLowerCase().includes(target) ? 60 : 0;
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
