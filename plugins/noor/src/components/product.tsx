// Noor's product page (a skin of the store's product page): the photos as a
// quiet column, the title, brand and rating, then the store's own buy form
// (price, options, buyer inputs, quantity and buttons, all kept current by
// the store), the description, reviews and related products. The buy form,
// reviews and recommendations are the store's embeds; Noor draws around them.

import { BuyForm, Image, Recommendations, Reviews, raw, t, type ProductMainProps } from "@scalius/plugin-sdk/storefront";
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
  const crumbs = product.breadcrumbs.slice(0, -1);
  return (
    <section class="noor-s noor-s-pdp" data-tone="plain" data-space="s">
      <div class="noor-wrap">
        {settings.show_breadcrumbs && crumbs.length > 0 ? (
          <nav class="noor-crumbs" aria-label={t(context, { en: "Breadcrumb", bn: "ব্রেডক্রাম্ব" })}>
            <ol>{crumbs.map((crumb) => <li><a href={crumb.url}>{crumb.title}</a><Icon name="chevron" size={12} /></li>)}</ol>
          </nav>
        ) : null}
        <div class={cx("noor-pdp", side === "end" && "is-flipped")}>
          <div class="noor-pdp-media" data-count={String(Math.min(product.media.length, 5))}>
            {product.media.map((image, index) => (
              <Image image={image} loading={index === 0 ? "eager" : "lazy"} class="noor-cover"
                sizes={index === 0 ? "(min-width: 768px) 55vw, 100vw" : "(min-width: 768px) 27vw, 50vw"} />
            ))}
          </div>
          <div class="noor-pdp-buy">
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
