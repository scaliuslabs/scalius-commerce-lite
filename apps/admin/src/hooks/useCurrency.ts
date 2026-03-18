import { useState, useEffect, useCallback } from "react";
import { formatPrice } from "@scalius/shared/currency";

const DEFAULT_SYMBOL = "৳";
const DEFAULT_CODE = "BDT";

// ---------------------------------------------------------------------------
// Module-level singleton: ONE fetch shared across all hook instances.
// Prevents N components each calling /admin/settings/currency on mount.
// ---------------------------------------------------------------------------

interface CurrencyData {
  symbol: string;
  code: string;
}

let cachedCurrency: CurrencyData | null = null;
let fetchPromise: Promise<CurrencyData> | null = null;
const listeners = new Set<(data: CurrencyData) => void>();

function getCurrencyData(): Promise<CurrencyData> {
  // Return cached immediately if available
  if (cachedCurrency) return Promise.resolve(cachedCurrency);

  // Deduplicate: if a fetch is already in flight, reuse it
  if (fetchPromise) return fetchPromise;

  // Try localStorage first (synchronous)
  try {
    const cached = localStorage.getItem("scalius_currency_cache");
    if (cached) {
      const data = JSON.parse(cached) as CurrencyData;
      if (data.symbol && data.code) {
        cachedCurrency = data;
      }
    }
  } catch {
    // localStorage unavailable
  }

  // Fetch fresh (single request)
  fetchPromise = fetch("/api/v1/admin/settings/currency")
    .then((res) => res.json())
    .then((json) => {
      const data =
        json.data && typeof json.data === "object" && !Array.isArray(json.data)
          ? json.data
          : json;
      const result: CurrencyData = {
        symbol: data.currencySymbol || DEFAULT_SYMBOL,
        code: data.currencyCode || DEFAULT_CODE,
      };
      cachedCurrency = result;
      localStorage.setItem("scalius_currency_cache", JSON.stringify(result));
      // Notify all mounted hooks
      listeners.forEach((cb) => cb(result));
      return result;
    })
    .catch(() => {
      const fallback = cachedCurrency || { symbol: DEFAULT_SYMBOL, code: DEFAULT_CODE };
      return fallback;
    })
    .finally(() => {
      fetchPromise = null; // Allow re-fetch on next navigation
    });

  return fetchPromise;
}

// ---------------------------------------------------------------------------
// Hook: reads from singleton, never fires its own fetch
// ---------------------------------------------------------------------------

export function useCurrency() {
  const [symbol, setSymbol] = useState(cachedCurrency?.symbol || DEFAULT_SYMBOL);
  const [code, setCode] = useState(cachedCurrency?.code || DEFAULT_CODE);

  useEffect(() => {
    // Subscribe to updates from the singleton
    const handler = (data: CurrencyData) => {
      setSymbol(data.symbol);
      setCode(data.code);
    };
    listeners.add(handler);

    // Trigger fetch (deduped — only one request in flight)
    getCurrencyData().then(handler);

    return () => {
      listeners.delete(handler);
    };
  }, []);

  const fmt = useCallback(
    (price: number | string) => formatPrice(price, { symbol, code }),
    [symbol, code],
  );

  return { symbol, code, fmt, formatPrice: fmt };
}
