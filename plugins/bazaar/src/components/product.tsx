// The Bazaar product page (a skin of the store's product page), the
// marketplace's three columns: the store's gallery; the centre column
// (title, "Visit the <brand> Store", stars and the ratings count, an
// optional choice badge, the price block with the percentage and the
// struck list price, and "About this item"); and the buy box (the store's
// own buy form: price, options, quantity, Add to Cart and Buy Now, kept
// current by the store), followed by the "Ships from / Sold by / Returns"
// table and "Other sellers" when the merchant links one. Below: the
// product information table (the product's public custom fields), the
// store's reviews and related products.

import { BuyForm, Gallery, Recommendations, Reviews, raw, t, type ProductMainProps, type StorefrontMoney } from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { BigPrice, SELLER_HANDLE_FIELD, SELLER_NAME_FIELD, Stars, cx, percentOff, ratingCount, ratingLabel, ratingValue, soldBy, text } from "./ui";

export interface ProductSettings {
  choice_badge: string | null;
  ships_from: string | null;
  returns_text: string | null;
  secure_text: string | null;
  other_sellers_label: string | null;
  other_sellers_link: string | null;
  show_info_table: boolean;
}

function isMoney(value: unknown): value is StorefrontMoney {
  return typeof value === "object" && value !== null && typeof (value as StorefrontMoney).formatted === "string" && typeof (value as StorefrontMoney).amountMinor === "number";
}

/** A custom field's value as table text; null for shapes a table cannot show. */
function fieldValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Money fields arrive as StorefrontMoney, with the store's text.
  if (isMoney(value)) return value.formatted;
  if (Array.isArray(value)) {
    if (value.every(isMoney)) return value.map((item) => item.formatted).join(", ");
    return value.every((item) => typeof item === "string" || typeof item === "number") ? value.join(", ") : null;
  }
  return null;
}

/** "material" / "care_guide" → "Material" / "Care guide". */
function fieldLabel(key: string): string {
  const name = key.slice(key.lastIndexOf(".") + 1).replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function ProductPage({ data, settings, context }: ProductMainProps<ProductSettings>) {
  const { product } = data;
  const crumbs = product.breadcrumbs.slice(1, -1);
  const seller = soldBy(product.fields);
  const sellerName = seller?.name ?? context.store.name;
  const discounted = product.compareAt !== null && product.compareAt.amountMinor > product.price.amountMinor;
  const percent = discounted ? Math.round((1 - product.price.amountMinor / product.compareAt!.amountMinor) * 100) : 0;
  const info = settings.show_info_table === false ? [] : Object.entries(product.fields)
    .filter(([key]) => key !== SELLER_NAME_FIELD && key !== SELLER_HANDLE_FIELD)
    .flatMap(([key, value]) => {
      const shown = fieldValue(value);
      return shown ? [{ label: fieldLabel(key), value: shown }] : [];
    }).slice(0, 20);
  const stock = product.availability === "out_of_stock"
    ? { class: "is-out", text: t(context, { en: "Currently unavailable.", bn: "এখন পাওয়া যাচ্ছে না।" }) }
    : product.availability === "low_stock"
      ? { class: "is-low", text: t(context, { en: "Only a few left in stock - order soon.", bn: "স্টকে অল্প বাকি - তাড়াতাড়ি অর্ডার করুন।" }) }
      : { class: "is-in", text: t(context, { en: "In Stock", bn: "স্টকে আছে" }) };
  const otherLink = text(settings.other_sellers_link);
  return (
    <div class="bz-pdp-shell">
      {crumbs.length > 0 ? (
        <nav class="bz-crumbs" aria-label={t(context, { en: "Breadcrumb", bn: "ব্রেডক্রাম্ব" })}>
          <ol>{crumbs.map((crumb, index) => <li>{index > 0 ? <span aria-hidden="true">›</span> : null}<a href={crumb.url}>{crumb.title}</a></li>)}</ol>
        </nav>
      ) : null}
      <div class="bz-pdp">
        <div class="bz-pdp-media" data-sticky-column>
          <Gallery />
        </div>
        <div class="bz-pdp-center">
          <h1 class="bz-pdp-title">{product.title}</h1>
          {product.brand ? <a class="bz-link bz-pdp-brand" href={product.brand.url}>{t(context, { en: `Visit the ${product.brand.title} Store`, bn: `${product.brand.title} স্টোর দেখুন` })}</a> : null}
          {product.rating ? (
            <p class="bz-pdp-rating">
              <span class="bz-pdp-avg" aria-hidden="true">{ratingValue(context, product.rating.average)}</span>
              <Stars value={product.rating.average} size="m" label={ratingLabel(context, product.rating.average, product.rating.count)} />
              <a class="bz-link" href="#bazaar-reviews">{ratingCount(context, product.rating.count)}</a>
            </p>
          ) : null}
          {text(settings.choice_badge) ? <p class="bz-choice"><span class="bz-choice-mark">{text(settings.choice_badge)}</span></p> : null}
          <hr class="bz-rule" />
          <div class="bz-pdp-price">
            {discounted ? <span class="bz-pdp-pct">{percentOff(context, percent)}</span> : null}
            {product.priceVaries ? <span class="bz-from">{t(context, { en: "From", bn: "থেকে" })}</span> : null}
            <BigPrice money={product.price} context={context} />
          </div>
          {discounted ? (
            <p class="bz-pdp-list">{t(context, { en: "List Price:", bn: "তালিকা মূল্য:" })} <s>{product.compareAt!.formatted}</s></p>
          ) : null}
          <hr class="bz-rule" />
          {product.descriptionHtml ? (
            <section class="bz-about">
              <h2>{t(context, { en: "About this item", bn: "এই পণ্য সম্পর্কে" })}</h2>
              <div class="bz-prose">{raw(product.descriptionHtml)}</div>
            </section>
          ) : null}
        </div>
        <aside class="bz-buybox" aria-label={t(context, { en: "Buy options", bn: "কেনার অপশন" })}>
          <div class="bz-buybox-card">
            <p class={cx("bz-stock", stock.class)}>{stock.text}</p>
            <BuyForm title={false} />
            <p class="bz-secure"><Icon name="lock" size={14} />{text(settings.secure_text) ?? t(context, { en: "Secure transaction", bn: "নিরাপদ লেনদেন" })}</p>
            <table class="bz-offer-table">
              <tbody>
                <tr><th scope="row">{t(context, { en: "Ships from", bn: "যেখান থেকে পাঠানো হয়" })}</th><td>{text(settings.ships_from) ?? sellerName}</td></tr>
                <tr><th scope="row">{t(context, { en: "Sold by", bn: "বিক্রেতা" })}</th><td>{seller?.url ? <a class="bz-link" href={seller.url}>{sellerName}</a> : sellerName}</td></tr>
                {text(settings.returns_text) ? <tr><th scope="row">{t(context, { en: "Returns", bn: "রিটার্ন" })}</th><td>{text(settings.returns_text)}</td></tr> : null}
              </tbody>
            </table>
          </div>
          {otherLink ? (
            <a class="bz-other-sellers" href={otherLink}>
              <span>{text(settings.other_sellers_label) ?? t(context, { en: "Other sellers on this store", bn: "এই স্টোরের অন্য বিক্রেতা" })}</span>
              <Icon name="chevron" size={16} />
            </a>
          ) : null}
        </aside>
      </div>
      {info.length > 0 ? (
        <section class="bz-band bz-info">
          <h2 class="bz-band-title">{t(context, { en: "Product information", bn: "পণ্যের তথ্য" })}</h2>
          <table class="bz-info-table"><tbody>{info.map((row) => <tr><th scope="row">{row.label}</th><td>{row.value}</td></tr>)}</tbody></table>
        </section>
      ) : null}
      <div id="bazaar-reviews" class="bz-band bz-pdp-reviews"><Reviews /></div>
      <div class="bz-band bz-pdp-related"><Recommendations /></div>
    </div>
  );
}
