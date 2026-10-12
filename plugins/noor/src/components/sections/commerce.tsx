// Noor's selling sections: a product showcase with up to three tabs (radio
// tabs: no script), shop-the-look (a photo with numbered hotspots beside
// its products) and a sale banner with a live countdown.

import {
  Image,
  Island,
  editable,
  t,
  type SectionProps,
  type StorefrontImage,
  type StorefrontProductCard,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "../icons";
import { Button, ProductCard, SectionHead, cx, text, type Context } from "../ui";

function Grid({ products, context, layout, columns }: { products: StorefrontProductCard[]; context: Context; layout: string; columns: number }) {
  return (
    <div class={cx("noor-products", `is-${layout}`)} style={{ "--noor-columns": Math.max(2, Math.min(5, Math.round(columns))) }}>
      {products.map((product) => <ProductCard product={product} context={context} />)}
    </div>
  );
}

export interface ShowcaseSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  link: string | null;
  link_label: string | null;
  tab1_label: string | null;
  tab1_products: StorefrontProductCard[];
  tab2_label: string | null;
  tab2_products: StorefrontProductCard[];
  tab3_label: string | null;
  tab3_products: StorefrontProductCard[];
  layout: string;
  columns: number;
}

export function ProductShowcase({ settings, context, instanceId }: SectionProps<ShowcaseSettings>) {
  const tabs = [
    { label: text(settings.tab1_label), products: settings.tab1_products },
    { label: text(settings.tab2_label), products: settings.tab2_products },
    { label: text(settings.tab3_label), products: settings.tab3_products },
  ].filter((tab) => tab.products.length > 0);
  if (tabs.length === 0) return null;
  const name = `noor-tab-${instanceId}`;
  return (
    <section class="noor-section noor-showcase">
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)}
        link={text(settings.link)} linkLabel={text(settings.link_label)} context={context} />
      {tabs.length > 1 ? (
        <div class="noor-tabs" style={{ "--noor-tab-count": tabs.length }}>
          <div class="noor-tablist" role="radiogroup" aria-label={text(settings.heading) ?? t(context, { en: "Products", bn: "পণ্য" })}>
            {tabs.map((tab, index) => (
              <label class="noor-tab">
                <input type="radio" name={name} value={String(index)} checked={index === 0} class="noor-tab-input" data-tab={String(index)} />
                <span>{tab.label ?? `${index + 1}`}</span>
              </label>
            ))}
          </div>
          {tabs.map((tab, index) => (
            <div class="noor-tabpanel" data-panel={String(index)}>
              <Grid products={tab.products} context={context} layout={settings.layout} columns={settings.columns} />
            </div>
          ))}
        </div>
      ) : <Grid products={tabs[0]!.products} context={context} layout={settings.layout} columns={settings.columns} />}
    </section>
  );
}

export interface LookSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  hotspots: Array<{ x: number | null; y: number | null; title: string | null; text: string | null; link: string | null }>;
  products: StorefrontProductCard[];
  image_side: string;
}

export function ShopTheLook({ settings, context }: SectionProps<LookSettings>) {
  if (!settings.image) return null;
  const spots = settings.hotspots.filter((spot) => text(spot.title));
  return (
    <section class={cx("noor-section noor-look", settings.image_side === "end" && "is-flipped")}>
      <div class="noor-look-media">
        <Image image={settings.image} sizes="(min-width: 900px) 55vw, 100vw" class="noor-look-img" />
        {spots.map((spot, index) => (
          <details class="noor-hotspot" style={{ left: `${Math.max(2, Math.min(98, spot.x ?? 50))}%`, top: `${Math.max(2, Math.min(98, spot.y ?? 50))}%` }}>
            <summary aria-label={spot.title!}><span aria-hidden="true">{index + 1}</span></summary>
            <div class="noor-hotspot-card">
              <strong>{spot.title}</strong>
              {text(spot.text) ? <p>{spot.text}</p> : null}
              {text(spot.link) ? <a href={spot.link!} class="noor-link-arrow">{t(context, { en: "View", bn: "দেখুন" })}<Icon name="arrow" size={16} /></a> : null}
            </div>
          </details>
        ))}
      </div>
      <div class="noor-look-side">
        <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} context={context} />
        {settings.products.length > 0 ? (
          <div class="noor-look-products">
            {settings.products.map((product) => <ProductCard product={product} context={context} options={{ ratio: "square", sizes: "(min-width: 900px) 18vw, 45vw" }} />)}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export interface CountdownSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  ends_at: string | null;
  label: string | null;
  link: string | null;
  image: StorefrontImage | null;
  tone: string;
}

/** The offset of `timeZone` from UTC at `epoch`, in ms. */
function zoneOffset(epoch: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - epoch;
}

/**
 * An end time the merchant typed (`2026-12-31` or `2026-12-31 18:00`) in the
 * store's time zone, as epoch ms; null when it is not one. A date alone ends
 * at the end of that day.
 */
export function countdownEnd(value: string | null, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const [, year, month, day, hour = "23", minute = "59"] = match;
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), hour === "23" && minute === "59" ? 59 : 0);
  if (!Number.isFinite(wall)) return null;
  try {
    return wall - zoneOffset(wall, timeZone);
  } catch {
    return wall;
  }
}

export function Countdown({ end, context, compact = false }: { end: number; context: Context; compact?: boolean }) {
  const units = [
    { key: "days", en: "Days", bn: "দিন" },
    { key: "hours", en: "Hours", bn: "ঘণ্টা" },
    { key: "minutes", en: "Min", bn: "মিনিট" },
    { key: "seconds", en: "Sec", bn: "সেকেন্ড" },
  ];
  return (
    <Island name="countdown" hydrate="visible" props={{ end }} class={cx("noor-countdown", compact && "is-compact")}>
      <ol class="noor-countdown-list" role="timer" aria-live="off">
        {units.map((unit) => (
          <li><span class="noor-countdown-value" data-unit={unit.key}>--</span><span class="noor-countdown-label">{t(context, unit)}</span></li>
        ))}
      </ol>
    </Island>
  );
}

export function PromoCountdown({ settings, context }: SectionProps<CountdownSettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  const end = countdownEnd(settings.ends_at, context.store.timeZone);
  return (
    <section class={cx("noor-section noor-promo", `tone-${settings.tone}`, settings.image && "has-image")}>
      {settings.image ? <Image image={settings.image} sizes="100vw" class="noor-promo-img" alt="" /> : null}
      <div class="noor-promo-inner">
        {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
        <h2 class="noor-display is-medium" {...editable(context, "heading")}>{heading}</h2>
        {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
        {end ? <Countdown end={end} context={context} /> : null}
        {text(settings.label) && text(settings.link)
          ? <Button href={settings.link!} variant={settings.tone === "dark" || settings.image ? "light" : "solid"} editableKey="label" context={context}>{settings.label}</Button>
          : null}
      </div>
    </section>
  );
}
