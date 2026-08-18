const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "did", "do", "for", "give", "how", "i", "is", "me",
  "my", "of", "on", "our", "please", "s", "show", "tell", "the", "this", "to", "we",
  "what", "which", "with",
]);

// Vocabulary normalization improves the low-level operation escape hatch. Goal
// routing belongs to the versioned workflow catalog, never to operation IDs here.
const MERCHANT_TERM_GROUPS = [
  ["today", "yesterday", "daily", "day", "week", "weekly"],
  ["sale", "sales", "sell", "sold", "revenue", "gmv", "activity", "summary"],
  ["order", "orders"],
  ["issue", "issues", "problem", "problems", "failure", "failures", "fail", "failed", "failing", "decline", "declined", "attention", "alert", "alerts", "blocking"],
  ["health", "healthy", "readiness", "ready", "status"],
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
  ["top", "best", "highest", "valuable", "value", "spending", "spender", "spenders"],
] as const;

const MUTATION_WORDS = new Set([
  "add", "apply", "begin", "buy", "cancel", "change", "checkout", "create", "delete", "make",
  "place", "publish", "purchase", "remove", "restore", "save", "set", "start", "submit",
  "update", "upload",
]);

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu)?.map((word) => word.toLocaleLowerCase()) ?? [];
}

function alternatives(term: string): readonly string[] {
  return MERCHANT_TERM_GROUPS.find((group) => group.includes(term as never)) ?? [term];
}

export function prefersReadOnlyMerchantResults(query: string): boolean {
  return !words(query).some((word) => MUTATION_WORDS.has(word));
}

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
    if (alternatives(term).some((candidate) =>
      searchableWords.has(candidate) || normalizedText.includes(candidate)
    )) {
      score += 3;
      continue;
    }
    return null;
  }
  return score;
}
