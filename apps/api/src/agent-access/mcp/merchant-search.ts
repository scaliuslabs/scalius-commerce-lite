const SEARCH_STOP_WORDS = new Set([
  "a", "an", "are", "can", "do", "for", "give", "how", "i", "is", "last", "low", "many", "me", "my", "mine",
  "month", "need", "needing", "of", "on", "our", "please", "s", "show", "tell", "the", "this", "to", "total", "what", "which", "with",
]);

const MERCHANT_TERM_GROUPS = [
  ["today", "yesterday", "daily", "day", "week", "weekly"],
  ["sale", "sales", "revenue", "gmv", "activity", "summary"],
  ["issue", "issues", "problem", "problems", "failure", "failures", "failed", "attention", "alert", "alerts", "recovery", "blocking"],
  ["health", "healthy", "readiness"],
  ["inventory", "inventories", "stock"],
  ["product", "products", "catalog", "merchandise"],
  ["customer", "customers", "buyer", "buyers", "shopper", "shoppers"],
  ["fulfillment", "fulfilment", "unfulfilled", "shipping", "shipment", "shipments", "delivery", "deliveries", "filter"],
  ["payment", "payments", "gateway", "gateways"],
  ["recent", "latest", "new", "list", "activity", "summary"],
  ["operational", "health", "healthy", "readiness", "status", "store", "checkout", "configuration"],
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

/** Keep this small matcher behavior-aligned with the published CLI search. */
export function matchesMerchantOperationQuery(searchableText: string, query: string): boolean {
  return merchantOperationQueryScore(searchableText, query) !== null;
}

export function merchantOperationQueryScore(searchableText: string, query: string): number | null {
  const terms = words(query).filter((term) => !SEARCH_STOP_WORDS.has(term));
  if (terms.length === 0) return 0;
  const searchableWords = new Set(words(searchableText));
  const normalizedText = searchableText.toLocaleLowerCase();
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
    return null;
  }
  return score;
}
