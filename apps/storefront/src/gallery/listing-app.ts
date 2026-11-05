// A gallery-only app (dev and test, never bundled into a build): one listing
// skin as a third-party theme writes it, the page's title, the store's
// filters and toolbar, then the results. The gallery checks the store's
// embeds inside a skin with it (a filter bar at 320px). Written with the
// SDK's JSX runtime directly: the storefront has no JSX for app modules.
import { Filters, Pagination, Toolbar, defineStorefront, type ListingMainProps } from "../../../../packages/plugin-sdk/src/storefront/index";
import { jsx } from "../../../../packages/plugin-sdk/src/storefront/jsx-runtime";

function Listing({ data }: ListingMainProps) {
  return jsx("div", {
    class: "gallery-listing",
    children: [
      jsx("h1", { children: data.title }),
      jsx(Filters, {}),
      jsx(Toolbar, {}),
      jsx("ul", {
        class: "gallery-listing-results",
        children: data.cards.map((card) => jsx("li", { children: jsx("a", { href: card.url, children: card.title }) })),
      }),
      jsx(Pagination, {}),
    ],
  });
}

export default defineStorefront({ skins: { gallery_listing: Listing } });
