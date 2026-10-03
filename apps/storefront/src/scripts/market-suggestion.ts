// The geo suggestion banner (components/markets/MarketSuggestion.astro). It
// runs after load and changes nothing until the private endpoint answers.
// A buyer who chose a market (the `localization` cookie) or dismissed the
// banner for this market is never asked.
import { MARKET_SELECTION_COOKIE } from "@scalius/shared/markets";

const DISMISSED_KEY = "market-suggestion:dismissed";

interface Suggestion {
  market: { id: string; name: string };
  country: string;
  countryName: string;
}

function hasChosenMarket(): boolean {
  return document.cookie.split(";").some((part) => part.trim().startsWith(`${MARKET_SELECTION_COOKIE}=`));
}

function dismissedMarket(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function initMarketSuggestion(): void {
  const banner = document.querySelector<HTMLElement>("[data-market-suggestion]");
  if (!banner || hasChosenMarket()) return;
  const endpoint = banner.dataset.endpoint;
  if (!endpoint) return;
  const run = async () => {
    const response = await fetch(`${endpoint}?path=${encodeURIComponent(location.pathname)}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const { suggestion } = await response.json() as { suggestion: Suggestion | null };
    if (!suggestion || dismissedMarket() === suggestion.market.id) return;
    const text = banner.querySelector<HTMLElement>("[data-market-suggestion-text]");
    const country = banner.querySelector<HTMLInputElement>("[data-market-suggestion-country]");
    if (!text || !country) return;
    text.textContent = (banner.dataset.template ?? "").replace("{country}", suggestion.countryName);
    country.value = suggestion.country;
    banner.querySelector("[data-market-suggestion-dismiss]")?.addEventListener("click", () => {
      banner.hidden = true;
      try {
        localStorage.setItem(DISMISSED_KEY, suggestion.market.id);
      } catch {
        // Private mode: the banner simply returns on the next page.
      }
    });
    banner.hidden = false;
  };
  const start = () => void run().catch(() => undefined);
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}
