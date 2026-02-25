import { useState, useEffect, useCallback } from "react";

const DEFAULT_SYMBOL = "৳";
const DEFAULT_CODE = "BDT";

let _cached: { symbol: string; code: string } | null = null;
let _fetchPromise: Promise<{ symbol: string; code: string }> | null = null;

export function useCurrency() {
  const [symbol, setSymbol] = useState(_cached?.symbol ?? DEFAULT_SYMBOL);
  const [code, setCode] = useState(_cached?.code ?? DEFAULT_CODE);

  useEffect(() => {
    if (_cached) {
      setSymbol(_cached.symbol);
      setCode(_cached.code);
      return;
    }

    if (!_fetchPromise) {
      _fetchPromise = fetch("/api/settings/currency")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const s = data?.currencySymbol || DEFAULT_SYMBOL;
          const c = data?.currencyCode || DEFAULT_CODE;
          _cached = { symbol: s, code: c };
          return _cached;
        })
        .catch(() => {
          _fetchPromise = null;
          return { symbol: DEFAULT_SYMBOL, code: DEFAULT_CODE };
        });
    }

    _fetchPromise.then((data) => {
      setSymbol(data.symbol);
      setCode(data.code);
    });
  }, []);

  const fmt = useCallback(
    (price: number) =>
      `${symbol}${price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    [symbol],
  );

  return { symbol, code, formatPrice: fmt };
}
