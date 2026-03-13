// src/lib/currency.ts
// Currency utilities for the storefront.

/** Get the currency symbol from the global window variable (set by Layout.astro) */
export function getCurrencySymbol(): string {
  if (typeof window !== "undefined" && (window as any).__CURRENCY_SYMBOL__) {
    return (window as any).__CURRENCY_SYMBOL__;
  }
  return "\u09F3"; // fallback ৳
}

/** Get the currency code from the global window variable */
export function getCurrencyCode(): string {
  if (typeof window !== "undefined" && (window as any).__CURRENCY_CODE__) {
    return (window as any).__CURRENCY_CODE__;
  }
  return "BDT"; // fallback
}

/** Format a price with the configured currency symbol */
export function formatPrice(price: number): string {
  const symbol = getCurrencySymbol();
  return `${symbol}${price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a price with no decimals */
export function formatPriceShort(price: number): string {
  const symbol = getCurrencySymbol();
  return `${symbol}${price.toLocaleString()}`;
}
