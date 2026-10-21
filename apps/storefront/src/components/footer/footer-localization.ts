// What the footer's localization forms draw (FooterLocalization.astro), built once by the layout.
import type { MarketMatrix, PublicMarket } from "@scalius/shared/markets";

export interface FooterLocalizationModel {
  matrix: MarketMatrix;
  /** Draw the country/region form (the store has more than one market). */
  markets: boolean;
  /** The page's market when it has two languages, with the country it is chosen with. */
  language: { market: PublicMarket; country: string } | null;
  presence: string | null;
  currencyCode: string;
  pageLanguage: string;
  returnTo: string;
}
