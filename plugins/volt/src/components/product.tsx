// The Volt product page, as the source store lays it out: the breadcrumb;
// the store's gallery at the start; at the end the brand, the title, a row
// of chips (price, regular price, status, product code, brand), the saved
// amount and the EMI line, the key features, the store's own buy form
// (options, quantity, buttons, kept current by the store), the WhatsApp
// inquiry and the delivery time. Under it a tab bar (Specification,
// Description, Warranty, Reviews) over anchored panels: the specification
// table from the product's `scalius.volt.specs` field, the description, the
// warranty text and the store's reviews; related products last.

import { BuyForm, Gallery, Recommendations, Reviews, raw, t, type ProductMainProps } from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { cx, savedLabel, text, type Context } from "./ui";

export interface ProductSettings {
  emi_text: string | null;
  emi_link: string | null;
  delivery_text: string | null;
  warranty_text: string | null;
  warranty_link: string | null;
  whatsapp: string | null;
  show_related: boolean;
}

/** One group of specification rows ("Display": Size, Type, ...). */
export interface SpecGroup {
  group: string;
  rows: Array<{ label: string; value: string }>;
}

/** The specification table a product's `scalius.volt.specs` field holds: groups of rows, or one flat list of rows. */
export function specGroups(value: unknown): SpecGroup[] {
  const row = (entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return null;
    const { label, value: cell } = entry as { label?: unknown; value?: unknown };
    return typeof label === "string" && label.trim() && typeof cell === "string" ? { label: label.trim(), value: cell.trim() } : null;
  };
  if (!Array.isArray(value)) return [];
  const flat = value.map(row).filter((entry): entry is { label: string; value: string } => entry !== null);
  if (flat.length > 0) return [{ group: "", rows: flat.slice(0, 80) }];
  return value.slice(0, 20).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { group, rows } = entry as { group?: unknown; rows?: unknown };
    const parsed = Array.isArray(rows) ? rows.map(row).filter((cell): cell is { label: string; value: string } => cell !== null) : [];
    return parsed.length > 0 ? [{ group: typeof group === "string" ? group.trim() : "", rows: parsed.slice(0, 40) }] : [];
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(0, 12) : [];
}

function status(context: Context, availability: string): { label: string; tone: string } {
  if (availability === "out_of_stock") return { label: t(context, { en: "Out of stock", bn: "স্টক নেই" }), tone: "is-off" };
  if (availability === "low_stock") return { label: t(context, { en: "Few left", bn: "অল্প বাকি" }), tone: "is-low" };
  return { label: t(context, { en: "In stock", bn: "স্টকে আছে" }), tone: "is-on" };
}

export function ProductPage({ settings, data, context }: ProductMainProps<ProductSettings>) {
  const { product } = data;
  const crumbs = product.breadcrumbs;
  const saved = savedLabel(context, product);
  const specs = specGroups(product.fields["scalius.volt.specs"]);
  const features = strings(product.fields["scalius.volt.key_features"]);
  const code = typeof product.fields["scalius.volt.product_code"] === "string" ? String(product.fields["scalius.volt.product_code"]) : null;
  const state = status(context, product.availability);
  const whatsapp = text(settings.whatsapp)?.replace(/[^0-9]/g, "") ?? "";
  const warranty = text(settings.warranty_text);
  const tabs = [
    specs.length > 0 ? { id: "volt-spec", label: t(context, { en: "Specification", bn: "স্পেসিফিকেশন" }) } : null,
    product.descriptionHtml ? { id: "volt-description", label: t(context, { en: "Description", bn: "বিবরণ" }) } : null,
    warranty ? { id: "volt-warranty", label: t(context, { en: "Warranty", bn: "ওয়ারেন্টি" }) } : null,
    { id: "volt-reviews", label: t(context, { en: "Reviews", bn: "রিভিউ" }) },
  ].filter((tab): tab is { id: string; label: string } => tab !== null);
  return (
    <div class="volt-pdp-page">
      <div class="volt-wrap">
        {crumbs.length > 1 ? (
          <nav class="volt-crumbs" aria-label={t(context, { en: "Breadcrumb", bn: "ব্রেডক্রাম্ব" })}>
            <ol>{crumbs.map((crumb, index) => (
              <li>{index === crumbs.length - 1 ? <span aria-current="page">{crumb.title}</span> : <a href={crumb.url}>{crumb.title}</a>}</li>
            ))}</ol>
          </nav>
        ) : null}
        <div class="volt-pdp">
          <div class="volt-pdp-media"><Gallery /></div>
          <div class="volt-pdp-info" data-sticky-column>
            {product.brand ? <a class="volt-pdp-brand" href={product.brand.url}>{product.brand.title}</a> : null}
            <h1 class="volt-pdp-title">{product.title}</h1>
            <ul class="volt-chips">
              <li><span>{t(context, { en: "Price", bn: "দাম" })}:</span> <strong>{product.price.formatted}</strong></li>
              {product.compareAt ? <li><span>{t(context, { en: "Regular Price", bn: "নিয়মিত দাম" })}:</span> <del>{product.compareAt.formatted}</del></li> : null}
              <li class={state.tone}><span>{t(context, { en: "Status", bn: "অবস্থা" })}:</span> <strong>{state.label}</strong></li>
              {code ? <li><span>{t(context, { en: "Product Code", bn: "পণ্য কোড" })}:</span> <strong>{code}</strong></li> : null}
              {product.brand ? <li><span>{t(context, { en: "Brand", bn: "ব্র্যান্ড" })}:</span> <strong>{product.brand.title}</strong></li> : null}
            </ul>
            {saved || text(settings.emi_text) ? (
              <div class="volt-pdp-offer">
                {saved ? <span class="volt-pill">{saved}</span> : null}
                {text(settings.emi_text) ? (
                  <p class="volt-emi"><Icon name="card" size={18} /><span>{text(settings.emi_text)}</span>
                    {text(settings.emi_link) ? <a href={text(settings.emi_link)!}>{t(context, { en: "View Plans", bn: "প্ল্যান দেখুন" })}</a> : null}</p>
                ) : null}
              </div>
            ) : null}
            {features.length > 0 ? (
              <div class="volt-features">
                <h2 class="volt-h3">{t(context, { en: "Key Features", bn: "মূল বৈশিষ্ট্য" })}</h2>
                <ul>{features.map((feature) => <li>{feature}</li>)}</ul>
              </div>
            ) : null}
            <BuyForm title={false} />
            <ul class="volt-pdp-help">
              {whatsapp.length >= 8 ? (
                <li><a href={`https://wa.me/${whatsapp}`} rel="noopener"><Icon name="whatsapp" size={18} />{t(context, { en: "Ask on WhatsApp", bn: "হোয়াটসঅ্যাপে জিজ্ঞাসা করুন" })}</a></li>
              ) : null}
              {text(settings.delivery_text) ? <li><Icon name="truck" size={18} /><span>{text(settings.delivery_text)}</span></li> : null}
              {text(settings.warranty_link) ? <li><Icon name="shield" size={18} /><a href={text(settings.warranty_link)!}>{t(context, { en: "Warranty policy", bn: "ওয়ারেন্টি নীতি" })}</a></li> : null}
            </ul>
          </div>
        </div>
        <nav class="volt-tabs-bar" aria-label={t(context, { en: "Product details", bn: "পণ্যের বিবরণ" })}>
          {tabs.map((tab, index) => <a class={cx("volt-tab", index === 0 && "is-active")} href={`#${tab.id}`}>{tab.label}</a>)}
        </nav>
        {specs.length > 0 ? (
          <section class="volt-panel" id="volt-spec">
            <h2 class="volt-h2">{t(context, { en: "Specification", bn: "স্পেসিফিকেশন" })}</h2>
            <table class="volt-spec">
              {specs.map((group) => (
                <tbody>
                  {group.group ? <tr class="volt-spec-group"><th colspan="2" scope="colgroup">{group.group}</th></tr> : null}
                  {group.rows.map((row) => <tr><th scope="row">{row.label}</th><td>{row.value.split("|").map((part, index) => index === 0 ? part.trim() : [<br />, part.trim()])}</td></tr>)}
                </tbody>
              ))}
            </table>
          </section>
        ) : null}
        {product.descriptionHtml ? (
          <section class="volt-panel" id="volt-description">
            <h2 class="volt-h2">{t(context, { en: "Description", bn: "বিবরণ" })}</h2>
            <div class="volt-prose">{raw(product.descriptionHtml)}</div>
          </section>
        ) : null}
        {warranty ? (
          <section class="volt-panel" id="volt-warranty">
            <h2 class="volt-h2">{t(context, { en: "Warranty", bn: "ওয়ারেন্টি" })}</h2>
            <div class="volt-prose">{warranty.split(/\n{2,}/).map((paragraph) => <p>{paragraph}</p>)}</div>
          </section>
        ) : null}
        <section class="volt-panel" id="volt-reviews"><Reviews /></section>
        {settings.show_related ? <div class="volt-related"><Recommendations /></div> : null}
      </div>
    </div>
  );
}
