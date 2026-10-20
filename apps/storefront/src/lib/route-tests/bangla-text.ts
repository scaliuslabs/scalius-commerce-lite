// What a Bangla page must not show, for the render and client tests: an
// English interface word, or a price or count in Latin digits. Merchant data
// in those fixtures is Bangla, so any Latin-letter word is the store's own
// interface talking English: the known interface words below are named in
// failures, and every other Latin word is reported too, so a new missed
// string fails the same way. `ALLOWED` holds the Latin words a Bangla page may
// truly carry. Test-only: nothing in the storefront imports this.

/** What a buyer reads or hears: the title, the meta description, visible text, and the labels assistive technology reads. */
export function buyerText(root: Document | Element): string[] {
  const document = "documentElement" in root ? root : root.ownerDocument;
  const scope = ("body" in root ? root.body : root).cloneNode(true) as HTMLElement;
  for (const hidden of scope.querySelectorAll("script, style, template, noscript, [hidden]")) hidden.remove();
  const labels = [...scope.querySelectorAll("[aria-label], [placeholder], [title], img[alt]")].flatMap((element) =>
    ["aria-label", "placeholder", "title", "alt"].map((name) => element.getAttribute(name) ?? ""));
  // Each text node on its own: elements' text runs together in textContent.
  const texts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) texts.push(node.textContent ?? "");
    for (const child of node.childNodes) walk(child);
  };
  walk(scope);
  const head = "documentElement" in root
    ? [document.title, document.querySelector('meta[name="description"]')?.getAttribute("content") ?? ""]
    : [];
  return [...head, ...texts, ...labels];
}

export const KNOWN_ENGLISH = new Set([
  "Home", "Breadcrumb", "All", "categories", "Search", "results", "products", "Delivery", "delivery", "Cash", "Free",
  "Pickup", "Returns", "Sort", "Filter", "Filters", "Price", "Add", "cart", "Buy", "now", "Quantity", "Reviews",
  "Description", "Details", "Previous", "Next", "Page", "Show", "more", "less", "Clear", "Apply", "Remove", "Browse",
  "Close", "Zoom", "Latest", "Featured", "Availability", "Top", "Similar", "Shop", "Cart", "Checkout", "Subtotal",
  "Undo", "Edit", "View", "Orders", "Order", "Profile", "Inbox", "Sign", "out", "Save", "Cancel", "Default", "Address",
  "Addresses", "Name", "Email", "Phone", "Downloads", "Gift", "cards", "Warranties", "Messages", "Send", "Reply",
  "Status", "Items", "Payment", "Total", "Placed", "Retry", "Try", "again", "Store", "You", "New",
]);
/** A gift-card code is Latin letters in every language: its field shows that shape. */
export const ALLOWED = new Set<string>(["XXXX"]);
const LATIN_WORD = /(?<![\p{L}\p{N}])([A-Za-z]{2,})(?![\p{L}\p{N}])/gu;

/** Each English text with its words: `"Sort by:" (known: Sort)`. */
export function englishTexts(root: Document | Element, allowed: ReadonlySet<string> = ALLOWED): string[] {
  const found = buyerText(root).flatMap((text) => {
    const words = [...text.matchAll(LATIN_WORD)].map((match) => match[1]!).filter((word) => !allowed.has(word));
    if (words.length === 0) return [];
    const known = words.filter((word) => KNOWN_ENGLISH.has(word));
    return [`"${text.trim().replace(/\s+/g, " ").slice(0, 80)}"${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`];
  });
  return [...new Set(found)];
}

/** Latin digits beside a Bangla currency sign or count word ("৳1,750", "12 টি"): numbers not in Bangla digits. */
export function latinNumbers(root: Document | Element): string[] {
  return [...new Set(buyerText(root).flatMap((text) => [...text.matchAll(/৳\s?[0-9][0-9,.]*|[0-9]+\s?টি/gu)].map((match) => match[0])))];
}
