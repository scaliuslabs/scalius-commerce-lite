// Noor's landing kit: the sections a campaign page for one product is made
// of (a Facebook or TikTok ad, a launch, an Eid offer). Each is its own
// section, so the merchant arranges them with any other section on a
// landing page (`/pages/<slug>`): a product hero with the price, the offer
// and "Order now"; features or steps; and the order section with the
// store's own order form (`<Checkout>`: name, phone, address, thana; the
// store checks it, prices delivery and places the cash-on-delivery order).
// "Order now" jumps to an available order form for the product. On phones a bar with the price and
// "Order now" stays at the bottom until the form is on screen.

import {
  Checkout,
  Image,
  Island,
  Price,
  editable,
  t,
  type SectionProps,
  type StorefrontImage,
  type StorefrontProductCard,
} from "@scalius/plugin-sdk/storefront";
import { ICON_NAMES, Icon, type IconName } from "../icons";
import { Section, SectionHead, Stars, choice, cx, ratingLabel, text, type Context } from "../ui";
import { Countdown, countdownEnd } from "./commerce";

function iconOf(value: unknown): IconName {
  return typeof value === "string" && (ICON_NAMES as string[]).includes(value) ? value as IconName : "check";
}

function phoneHref(value: string | null): string | null {
  const digits = (value ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 6 ? `tel:${digits}` : null;
}

function whatsappHref(value: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? `https://wa.me/${digits}` : null;
}

function Empty({ context, words }: { context: Context; words: { en: string; bn: string } }) {
  return context.preview ? <Section name="landing-empty" space="s"><p class="noor-empty">{t(context, words)}</p></Section> : null;
}

function Savings({ product, context }: { product: StorefrontProductCard; context: Context }) {
  if (!product.compareAt || product.compareAt.amount <= product.price.amount) return null;
  return <span class="noor-save">{t(context, { en: `Save ${product.percentOff ?? 0}%`, bn: `${product.percentOff ?? 0}% ছাড়` })}</span>;
}

// ── Product hero ─────────────────────────────────────────────────────────

export interface LandingHeroSettings {
  product: StorefrontProductCard | null;
  badge: string | null;
  heading: string | null;
  text: string | null;
  photos: Array<{ image: StorefrontImage | null }>;
  points: Array<{ text: string | null }>;
  ends_at: string | null;
  urgency: string | null;
  cta_label: string | null;
  phone: string | null;
  whatsapp: string | null;
  image_side: string;
  tone: string;
}

export function LandingHero({ settings, context, instanceId }: SectionProps<LandingHeroSettings>) {
  const product = settings.product;
  if (!product) return <Empty context={context} words={{ en: "Choose the product this page sells in the section's settings.", bn: "সেকশনের সেটিংসে এই পেজের প্রোডাক্টটি বাছুন।" }} />;
  const photos = [...settings.photos.map((photo) => photo.image), product.image, product.hoverImage]
    .filter((image): image is StorefrontImage => image !== null)
    .filter((image, index, all) => all.findIndex((other) => other.url === image.url) === index)
    .slice(0, 8);
  const points = settings.points.flatMap((point) => (text(point.text) ? [text(point.text)!] : []));
  const end = countdownEnd(settings.ends_at, context.store.timeZone);
  const cta = text(settings.cta_label) ?? t(context, { en: "Order now", bn: "এখনই অর্ডার করুন" });
  const call = phoneHref(text(settings.phone));
  const chat = whatsappHref(text(settings.whatsapp));
  return (
    <Section name="lhero" tone={settings.tone} space="m">
      <div class={cx("noor-lhero", settings.image_side === "end" && "is-flipped")}>
        <Island name="slideshow" hydrate="visible" props={{ autoplay: false }} class="noor-lhero-gallery">
          <ul class="noor-lhero-photos" data-track tabindex="0" aria-label={t(context, { en: "Photos", bn: "ছবি" })}>
            {photos.map((photo, index) => (
              <li data-slide id={`noor-${instanceId}-photo-${index}`}>
                <Image image={photo} sizes="(min-width: 900px) 46vw, 100vw" loading={index === 0 ? "eager" : "lazy"}
                  alt={index === 0 ? product.title : photo.alt} class="noor-cover" />
              </li>
            ))}
          </ul>
          {product.percentOff ? <span class="noor-badge is-sale is-large">−{product.percentOff}%</span> : null}
          {photos.length > 1 ? (
            <ol class="noor-thumbs" data-controls hidden>
              {photos.map((photo, index) => (
                <li><button type="button" data-dot={String(index)} aria-current={index === 0 ? "true" : "false"}
                  aria-label={t(context, { en: `Photo ${index + 1}`, bn: `ছবি ${index + 1}` })}>
                  <Image image={photo} sizes="72px" alt="" class="noor-cover" />
                </button></li>
              ))}
            </ol>
          ) : null}
        </Island>
        <div class="noor-lhero-info">
          {text(settings.badge) ? <p class="noor-pill" {...editable(context, "badge")}>{settings.badge}</p> : null}
          <h1 class="noor-h1" {...editable(context, "heading")}>{text(settings.heading) ?? product.title}</h1>
          {product.rating ? (
            <p class="noor-rating-line">
              <Stars value={product.rating.average} label={ratingLabel(context, product.rating.average, product.rating.count)} />
              <span>{product.rating.average.toFixed(1)} · {t(context, { en: `${product.rating.count} reviews`, bn: `${product.rating.count}টি রিভিউ` })}</span>
            </p>
          ) : null}
          <div class="noor-lhero-price">
            <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price is-xl" />
            <Savings product={product} context={context} />
          </div>
          {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
          {points.length > 0 ? <ul class="noor-checks is-large">{points.map((point) => <li><Icon name="check" size={18} />{point}</li>)}</ul> : null}
          {end ? (
            <div class="noor-lhero-timer">
              <p class="noor-urgency" {...editable(context, "urgency")}>{text(settings.urgency) ?? t(context, { en: "Offer ends in", bn: "অফার শেষ হবে" })}</p>
              <Countdown end={end} context={context} size="s" />
            </div>
          ) : text(settings.urgency) ? <p class="noor-urgency" {...editable(context, "urgency")}>{settings.urgency}</p> : null}
          {product.soldOut ? (
            <p class="noor-soldout">{t(context, { en: "Sold out for now", bn: "আপাতত স্টক শেষ" })}</p>
          ) : (
            <div class="noor-lhero-actions">
              <Island name="landing-link" hydrate="idle" props={{ productId: product.id }}>
                <a class="noor-btn is-solid is-xl" href={product.url} data-noor-order-link><span {...editable(context, "cta_label")}>{cta}</span><Icon name="arrow" size={18} /></a>
              </Island>
              {call || chat ? (
                <div class="noor-contact-row">
                  {call ? <a class="noor-btn is-outline" href={call}><Icon name="phone" size={18} /><span>{t(context, { en: "Call to order", bn: "কল করে অর্ডার" })}</span></a> : null}
                  {chat ? <a class="noor-btn is-outline" href={chat} rel="noopener" target="_blank"><Icon name="whatsapp" size={18} /><span>WhatsApp</span></a> : null}
                </div>
              ) : null}
            </div>
          )}
          <p class="noor-cod-line"><Icon name="check" size={18} />{t(context, { en: "Review your order before placing it", bn: "অর্ডার দেওয়ার আগে বিস্তারিত দেখে নিন" })}</p>
        </div>
      </div>
    </Section>
  );
}

// ── Features and steps ───────────────────────────────────────────────────

export interface LandingFeaturesSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  items: Array<{ icon: string | null; image: StorefrontImage | null; title: string | null; text: string | null }>;
  style: string;
  cta_label: string | null;
  tone: string;
  spacing: string;
}

export function LandingFeatures({ settings, context }: SectionProps<LandingFeaturesSettings>) {
  const items = settings.items.filter((item) => text(item.title));
  if (items.length === 0) return null;
  const style = choice(settings.style, ["cards", "rows", "steps"] as const, "cards");
  return (
    <Section name="features" tone={settings.tone} space={settings.spacing}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} align="center" context={context} />
      {style === "rows" ? (
        <ul class="noor-rows">
          {items.map((item, index) => (
            <li class={cx("noor-split", !item.image && "is-text", index % 2 === 1 && "is-flipped")}>
              {item.image ? <div class="noor-split-media"><Image image={item.image} sizes="(min-width: 768px) 46vw, 100vw" class="noor-cover" /></div> : null}
              <div class="noor-split-copy">
                <h3 class="noor-h3">{item.title}</h3>
                {text(item.text) ? <p class="noor-lede">{item.text}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ol class={cx("noor-features", `is-${style}`, `count-${Math.min(items.length, 4)}`)}>
          {items.map((item, index) => (
            <li class="noor-feature">
              {style === "steps"
                ? <span class="noor-step" aria-hidden="true">{index + 1}</span>
                : item.image
                  ? <span class="noor-feature-photo"><Image image={item.image} sizes="(min-width: 768px) 25vw, 50vw" class="noor-cover" alt="" /></span>
                  : <span class="noor-feature-icon"><Icon name={iconOf(item.icon)} size={22} /></span>}
              <h3 class="noor-h4">{item.title}</h3>
              {text(item.text) ? <p>{item.text}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {text(settings.cta_label) ? (
        <Island name="landing-link" hydrate="idle" class="noor-actions-row is-center">
          <a class="noor-btn is-solid is-large" data-noor-order-link hidden><span {...editable(context, "cta_label")}>{settings.cta_label}</span><Icon name="arrow" size={16} /></a>
        </Island>
      ) : null}
    </Section>
  );
}

// ── The order ────────────────────────────────────────────────────────────

export interface LandingOrderSettings {
  product: StorefrontProductCard | null;
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  submit_label: string | null;
  max_quantity: number;
  assurances: Array<{ icon: string | null; text: string | null }>;
  phone: string | null;
  sticky_bar: boolean;
  bar_label: string | null;
  tone: string;
}

export function LandingOrder({ settings, context, instanceId }: SectionProps<LandingOrderSettings>) {
  const product = settings.product;
  if (!product) return <Empty context={context} words={{ en: "Choose the product to order in the section's settings.", bn: "সেকশনের সেটিংসে অর্ডারের প্রোডাক্টটি বাছুন।" }} />;
  const assurances = settings.assurances.filter((item) => text(item.text));
  const call = phoneHref(text(settings.phone));
  const barLabel = text(settings.bar_label) ?? t(context, { en: "Order now", bn: "অর্ডার করুন" });
  const orderAnchor = `noor-order-${instanceId}`;
  return (
    <Section name="order" tone={settings.tone} space="m" id={orderAnchor}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading) ?? t(context, { en: "Place your order", bn: "অর্ডার করতে নিচের ফর্মটি পূরণ করুন" })}
        body={text(settings.text)} align="center" context={context} />
      {product.soldOut ? (
        <p class="noor-soldout is-center">{t(context, { en: "Sold out for now. Please check back soon.", bn: "আপাতত স্টক শেষ। শিগগিরই আবার দেখুন।" })}</p>
      ) : (
        <div class="noor-order" data-noor-order-product={product.id}>
          <aside class="noor-order-summary" aria-label={t(context, { en: "Your order", bn: "আপনার অর্ডার" })}>
            <div class="noor-order-product">
              {product.image ? <Image image={product.image} sizes="96px" alt="" class="noor-order-thumb" /> : null}
              <div>
                <p class="noor-order-name">{product.title}</p>
                <div class="noor-order-price">
                  <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
                  <Savings product={product} context={context} />
                </div>
              </div>
            </div>
            {assurances.length > 0 ? <ul class="noor-assure">
              {assurances.map((item) => <li><Icon name={iconOf(item.icon)} size={18} /><span>{item.text}</span></li>)}
            </ul> : null}
            {call ? (
              <a class="noor-order-call" href={call}>
                <Icon name="phone" size={18} />
                <span><small>{t(context, { en: "Prefer to call?", bn: "কল করে অর্ডার করতে চান?" })}</small>{settings.phone}</span>
              </a>
            ) : null}
          </aside>
          <div class="noor-order-form">
            <Checkout product={product} maxQuantity={settings.max_quantity} submitLabel={text(settings.submit_label) ?? undefined} />
          </div>
        </div>
      )}
      {settings.sticky_bar && !product.soldOut ? (
        <Island name="landing-bar" hydrate="idle" props={{ target: orderAnchor }} class="noor-bar">
          <div class="noor-bar-inner">
            <div class="noor-bar-price">
              <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
            </div>
            <a class="noor-btn is-solid" href={`#${orderAnchor}`}>{barLabel}<Icon name="arrow" size={16} /></a>
          </div>
        </Island>
      ) : null}
    </Section>
  );
}
