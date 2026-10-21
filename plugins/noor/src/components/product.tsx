// Noor's product page (a skin of the store's product page): the store's
// gallery (one photo at a time with thumbnails, swipe on phones, zoom, the
// chosen variant's photo) beside the title, brand and rating and the store's
// own buy form (price, options, buyer inputs, quantity and buttons, kept
// current by the store), then the description, reviews and related products.
// On computers the buy column stays in view while the page scrolls (the
// store's sticky column, which also handles a column taller than the
// window). The gallery, buy form, reviews and recommendations are the
// store's embeds; Noor draws around them.

import { BuyForm, Gallery, Recommendations, Reviews, raw, t, type ProductMainProps } from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { Stars, choice, cx, ratingLabel, ratingValue, reviewCount } from "./ui";

interface ProductSkinSettings {
  media_side: string;
  show_breadcrumbs: boolean;
  show_description: boolean;
  show_reviews: boolean;
  show_related: boolean;
}

export function ProductPage({ settings, data, context }: ProductMainProps<ProductSkinSettings>) {
  const { product } = data;
  const side = choice(settings.media_side, ["start", "end"] as const, "start");
  const crumbs = product.breadcrumbs;
  return (
    <section class="noor-s noor-s-pdp" data-tone="plain" data-space="s">
      <div class="noor-wrap">
        {settings.show_breadcrumbs && crumbs.length > 1 ? (
          <nav class="noor-crumbs" aria-label={t(context, { en: "Breadcrumb", bn: "ব্রেডক্রাম্ব" })}>
            <ol>
              {crumbs.map((crumb, index) => index < crumbs.length - 1
                ? <li><a href={crumb.url}>{crumb.title}</a><Icon name="chevron" size={12} /></li>
                : <li><span aria-current="page">{crumb.title}</span></li>)}
            </ol>
          </nav>
        ) : null}
        <div class={cx("noor-pdp", side === "end" && "is-flipped")}>
          <div class="noor-pdp-media">
            <Gallery />
          </div>
          <div class="noor-pdp-buy" data-sticky-column>
            {product.brand ? <p class="noor-eyebrow"><a href={product.brand.url}>{product.brand.title}</a></p> : null}
            <h1 class="noor-h1">{product.title}</h1>
            {product.rating ? (
              <p class="noor-rating-line">
                <Stars value={product.rating.average} label={ratingLabel(context, product.rating.average, product.rating.count)} />
                <span>{ratingValue(context, product.rating.average)} · {reviewCount(context, product.rating.count)}</span>
              </p>
            ) : null}
            <BuyForm title={false} />
          </div>
        </div>
        {settings.show_description && product.descriptionHtml ? <div class="noor-prose noor-pdp-description">{raw(product.descriptionHtml)}</div> : null}
        {settings.show_reviews ? <Reviews /> : null}
        {settings.show_related ? <Recommendations /> : null}
      </div>
    </section>
  );
}
