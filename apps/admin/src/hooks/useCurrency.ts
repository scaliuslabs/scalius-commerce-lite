import { useState, useEffect, useCallback } from "react";

const DEFAULT_SYMBOL = "৳";
const DEFAULT_CODE = "BDT";

let _cached: { symbol: string; code: string } | null = null;
let _fetchPromise: Promise<{ symbol: string; code: string }> | null = null;

export function useCurrency() {
  // Initialize from memory cache or localStorage
  if (!_cached && typeof window !== "undefined") {
    try {
      const stored = localStorage.getItem("scalius_currency_cache");
      if (stored) {
        _cached = JSON.parse(stored);
      }
    } catch (err) {
      // Ignore parse errors
    }
  }

  const [symbol, setSymbol] = useState(_cached?.symbol ?? DEFAULT_SYMBOL);
  const [code, setCode] = useState(_cached?.code ?? DEFAULT_CODE);

  useEffect(() => {
    // Always trigger a background fetch once per session to keep it fresh
    let hasFetchedThisSession = false;
    if (typeof window !== "undefined") {
      try {
        hasFetchedThisSession = !!sessionStorage.getItem("scalius_currency_fetched");
      } catch (err) { }
    }

    // Only fetch if we haven't fetched in this tab session yet
    if (!hasFetchedThisSession && !_fetchPromise) {
      _fetchPromise = fetch("/api/v1/admin/settings/currency")
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          const data = json?.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
          const s = data?.currencySymbol || DEFAULT_SYMBOL;
          const c = data?.currencyCode || DEFAULT_CODE;
          _cached = { symbol: s, code: c };
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem("scalius_currency_cache", JSON.stringify(_cached));
              sessionStorage.setItem("scalius_currency_fetched", "true");
            } catch (e) {
              // Ignore standard storage errors
            }
          }
          return _cached;
        })
        .catch(() => {
          _fetchPromise = null; // allow retry on next mount if failed
          return { symbol: DEFAULT_SYMBOL, code: DEFAULT_CODE };
        });
    }

    if (_fetchPromise) {
      _fetchPromise.then((data) => {
        setSymbol(data.symbol);
        setCode(data.code);
      });
    }
  }, []);

  const fmt = useCallback(
    (price: number) =>
      `${symbol}${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    [symbol],
  );

  return { symbol, code, formatPrice: fmt };
}
