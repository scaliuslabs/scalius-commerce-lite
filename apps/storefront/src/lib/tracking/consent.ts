// The consent the page's boot script published (components/consent). A page
// without it carries no tag or server destination that needs consent, so
// nothing is gated there.

type Category = "analytics" | "marketing";

export function consentAllows(category: Category): boolean {
  if (typeof window === "undefined") return false;
  const consent = window.__scaliusConsent;
  return !consent || consent[category] === true;
}

/** Meta and TikTok pixels and their server relays. */
export function marketingAllowed(): boolean {
  return consentAllows("marketing");
}

/** The buyer refused the sale or sharing of data (US laws; Meta Limited Data Use). */
export function saleOfDataRefused(): boolean {
  return typeof window !== "undefined" && window.__scaliusConsent?.saleOfData === false;
}
