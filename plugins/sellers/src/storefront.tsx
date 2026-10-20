// The Sellers app's storefront module: "Sold by <seller>" in the product
// page's buy box and an "About the seller" block below it (both from the
// product's public seller fields, drawn for any theme), and a seller
// directory section from the published seller profiles. Themes that draw
// their own seller line (Bazaar) read the same fields.

import { defineStorefront, t, type ComponentProps, type SectionProps } from "@scalius/plugin-sdk/storefront";

const NAME = "scalius.sellers.seller_name";
const HANDLE = "scalius.sellers.seller_handle";
const PROFILES = "scalius.sellers.seller_profiles";

function sellerOf(fields: Record<string, unknown>): { name: string; url: string | null } | null {
  const name = typeof fields[NAME] === "string" ? (fields[NAME] as string).trim() : "";
  if (!name) return null;
  const handle = typeof fields[HANDLE] === "string" ? (fields[HANDLE] as string).trim() : "";
  return { name: name.slice(0, 120), url: /^[a-z0-9-]{1,100}$/.test(handle) ? `/apps/scalius.sellers/store/${handle}` : null };
}

function SoldBy(input: ComponentProps<{ label: string | null }>) {
  if (!("data" in input)) return null;
  const { data, context, settings } = input;
  const seller = sellerOf(data.product.fields);
  if (!seller) return null;
  const label = settings.label?.trim() || t(context, { en: "Sold by", bn: "বিক্রেতা" });
  return (
    <p class="sellers-sold-by">
      <span>{label}</span> {seller.url ? <a href={seller.url}>{seller.name}</a> : <strong>{seller.name}</strong>}
    </p>
  );
}

function AboutSeller(input: ComponentProps) {
  if (!("data" in input)) return null;
  const { data, context } = input;
  const seller = sellerOf(data.product.fields);
  if (!seller) return null;
  return (
    <section class="sellers-about-block" aria-label={t(context, { en: "About the seller", bn: "বিক্রেতা সম্পর্কে" })}>
      <h2>{t(context, { en: "About the seller", bn: "বিক্রেতা সম্পর্কে" })}</h2>
      <p>{t(context, { en: `This product is sold and shipped by ${seller.name}, a seller on ${context.store.name}.`, bn: `এই পণ্যটি ${context.store.name}-এর বিক্রেতা ${seller.name} বিক্রি ও পাঠান।` })}</p>
      {seller.url ? <p><a class="sellers-link" href={seller.url}>{t(context, { en: `Visit ${seller.name}`, bn: `${seller.name} দেখুন` })}</a></p> : null}
    </section>
  );
}

function Directory({ objects, settings, context }: SectionProps<{ heading: string | null; text: string | null; apply_label: string | null }>) {
  const records = objects[PROFILES]?.records ?? [];
  const heading = settings.heading?.trim() || t(context, { en: "Our sellers", bn: "আমাদের বিক্রেতারা" });
  const applyLabel = settings.apply_label?.trim();
  return (
    <section class="sellers-directory">
      <h2>{heading}</h2>
      {settings.text?.trim() ? <p>{settings.text.trim()}</p> : null}
      {records.length > 0 ? (
        <ul>
          {records.map((record) => (
            <li>
              {record.handle ? <a href={`/apps/scalius.sellers/store/${record.handle}`}>{String(record.data.name ?? record.handle)}</a> : <span>{String(record.data.name ?? "")}</span>}
              {typeof record.data.about === "string" && record.data.about ? <p>{record.data.about.slice(0, 160)}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {applyLabel ? <p><a class="sellers-link" href="/apps/scalius.sellers/apply">{applyLabel}</a></p> : null}
    </section>
  );
}

export default defineStorefront({
  sections: { seller_directory: Directory },
  components: { sold_by: SoldBy, about_seller: AboutSeller },
});
