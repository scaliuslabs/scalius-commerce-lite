import { useState, useEffect, useCallback } from "react";
import { formatPrice } from "@scalius/shared/currency";

const DEFAULT_SYMBOL = "৳";
const DEFAULT_CODE = "BDT";

export function useCurrency() {
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [code, setCode] = useState(DEFAULT_CODE);

  useEffect(() => {
    // Try localStorage cache first
    try {
      const cached = localStorage.getItem("scalius_currency_cache");
      if (cached) {
        const data = JSON.parse(cached);
        if (data.symbol) setSymbol(data.symbol);
        if (data.code) setCode(data.code);
      }
    } catch {}

    // Fetch fresh from API
    fetch("/api/v1/admin/settings/currency")
      .then((res) => res.json())
      .then((json) => {
        const data =
          json.data && typeof json.data === "object" && !Array.isArray(json.data)
            ? json.data
            : json;
        const newSymbol = data.currencySymbol || DEFAULT_SYMBOL;
        const newCode = data.currencyCode || DEFAULT_CODE;
        setSymbol(newSymbol);
        setCode(newCode);
        localStorage.setItem(
          "scalius_currency_cache",
          JSON.stringify({ symbol: newSymbol, code: newCode }),
        );
      })
      .catch(() => {});
  }, []);

  const fmt = useCallback(
    (price: number | string) => formatPrice(price, { symbol, code }),
    [symbol, code],
  );

  return { symbol, code, fmt, formatPrice: fmt };
}
