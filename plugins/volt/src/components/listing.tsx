// The Volt listing (category, collection, brand, search), as the source
// store lays it out: the breadcrumb, the banner, the title with
// "Showing: (N Items)", the store's filters in a sidebar at the start, the
// store's sort control above a grid of cards with "Shop Now", the store's
// numbered pages, and the merchant's description below.

import { Filters, Image, Pagination, Toolbar, formatNumber, raw, t, type ListingMainProps } from "@scalius/plugin-sdk/storefront";
import { CardGrid, whole } from "./ui";

export interface ListingSettings {
  columns: number;
  title_suffix: string | null;
  card_button: string;
}

export function Listing({ settings, data, context }: ListingMainProps<ListingSettings>) {
  const suffix = typeof settings.title_suffix === "string" ? settings.title_suffix.trim() : "";
  const title = data.kind !== "search" && suffix ? `${data.title} ${suffix}` : data.title;
  const count = `${formatNumber(context, data.total)}${data.totalIsCapped ? "+" : ""}`;
  return (
    <div class="volt-listing-page">
      <div class="volt-wrap">
        {data.breadcrumbs.length > 0 ? (
          <nav class="volt-crumbs" aria-label={t(context, { en: "Breadcrumb", bn: "ব্রেডক্রাম্ব" })}>
            <ol>
              {data.breadcrumbs.map((crumb) => <li><a href={crumb.url}>{crumb.title}</a></li>)}
              <li><span aria-current="page">{data.title}</span></li>
            </ol>
          </nav>
        ) : null}
        {data.image ? <div class="volt-listing-banner"><Image image={data.image} loading="eager" sizes="100vw" /></div> : null}
        <div class="volt-listing">
          <aside class="volt-listing-side"><Filters /></aside>
          <div class="volt-listing-main">
            <div class="volt-listing-head">
              <div>
                <h1 class="volt-h1">{title}</h1>
                <p class="volt-sub">{t(context, { en: `Showing: (${count} Items)`, bn: `দেখানো হচ্ছে: (${count}টি পণ্য)` })}</p>
              </div>
              <Toolbar />
            </div>
            {data.cards.length > 0 ? (
              <CardGrid cards={data.cards} context={context} columns={whole(settings.columns, 2, 5, 4)}
                button={settings.card_button === "cart" ? "cart" : settings.card_button === "none" ? "none" : "shop"} eagerFirst={4} />
            ) : (
              <p class="volt-empty">{t(context, { en: "No products found.", bn: "কোনো পণ্য পাওয়া যায়নি।" })}</p>
            )}
            <Pagination />
          </div>
        </div>
        {data.descriptionHtml ? <div class="volt-prose volt-listing-about">{raw(data.descriptionHtml)}</div> : null}
      </div>
    </div>
  );
}
