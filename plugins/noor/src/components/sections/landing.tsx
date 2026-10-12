// Noor's order landing: the single-page product landing Bangladeshi
// F-commerce runs on. The product's photos and price beside its promises and
// a countdown, "Order now" buttons that jump to the order, and the store's
// own order form (`<Checkout>`: name, phone, address, thana; the store checks
// it, prices delivery and places the cash-on-delivery order). On phones a
// bar with the price and "Order now" stays at the bottom until the form is
// on screen (the landing-bar island; without script the bar simply stays).

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
import { Stars, cx, text } from "../ui";
import { Countdown, countdownEnd } from "./commerce";

export interface LandingSettings {
  product: StorefrontProductCard | null;
  eyebrow: string | null;
  heading: string | null;
  subheading: string | null;
  photos: Array<{ image: StorefrontImage | null }>;
  benefits: Array<{ text: string | null }>;
  ends_at: string | null;
  urgency: string | null;
  cta_label: string | null;
  badges: Array<{ icon: string | null; text: string | null }>;
  order_heading: string | null;
  order_text: string | null;
  submit_label: string | null;
  max_quantity: number;
  sticky_bar: boolean;
  tone: string;
}

export function OrderLanding({ settings, context, instanceId }: SectionProps<LandingSettings>) {
  const product = settings.product;
  if (!product) {
    return context.preview ? (
      <section class="noor-section noor-landing-empty">
        <p>{t(context, { en: "Choose the product this landing sells in the section's settings.", bn: "সেকশনের সেটিংসে এই ল্যান্ডিংয়ের পণ্যটি বাছুন।" })}</p>
      </section>
    ) : null;
  }
  const orderId = `order-${instanceId}`;
  const photos = [product.image, ...settings.photos.map((photo) => photo.image)].filter((image): image is StorefrontImage => image !== null);
  const benefits = settings.benefits.flatMap((benefit) => (text(benefit.text) ? [text(benefit.text)!] : []));
  const badges = settings.badges.filter((badge) => text(badge.text));
  const end = countdownEnd(settings.ends_at, context.store.timeZone);
  const cta = text(settings.cta_label) ?? t(context, { en: "Order now", bn: "এখনই অর্ডার করুন" });
  const heading = text(settings.heading) ?? product.title;
  return (
    <section class={cx("noor-landing", `tone-${settings.tone}`)}>
      <div class="noor-landing-hero">
        <div class="noor-landing-gallery">
          <div class="noor-landing-photos" tabindex="0" aria-label={t(context, { en: "Photos", bn: "ছবি" })}>
            {photos.map((photo, index) => (
              <figure class="noor-landing-photo">
                <Image image={photo} sizes="(min-width: 900px) 50vw, 100vw" loading={index === 0 ? "eager" : "lazy"}
                  alt={index === 0 ? product.title : photo.alt} />
              </figure>
            ))}
          </div>
          {product.percentOff ? <span class="noor-landing-flag">−{product.percentOff}%</span> : null}
        </div>
        <div class="noor-landing-info">
          {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
          <h1 class="noor-display is-medium" {...editable(context, "heading")}>{heading}</h1>
          {product.rating ? (
            <p class="noor-landing-rating">
              <Stars value={product.rating.average} label={t(context, { en: `Rated ${product.rating.average.toFixed(1)} of 5`, bn: `৫-এ ${product.rating.average.toFixed(1)}` })} />
              <span>{product.rating.average.toFixed(1)} · {t(context, { en: `${product.rating.count} reviews`, bn: `${product.rating.count}টি রিভিউ` })}</span>
            </p>
          ) : null}
          {text(settings.subheading) ? <p class="noor-lede" {...editable(context, "subheading")}>{settings.subheading}</p> : null}
          <div class="noor-landing-price">
            <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price is-large" />
            {product.compareAt ? (
              <span class="noor-save">{t(context, { en: `You save ${product.percentOff ?? 0}%`, bn: `${product.percentOff ?? 0}% সাশ্রয়` })}</span>
            ) : null}
          </div>
          {benefits.length > 0 ? (
            <ul class="noor-checklist">
              {benefits.map((benefit) => <li><span class="noor-check" aria-hidden="true"><Icon name="check" size={16} /></span>{benefit}</li>)}
            </ul>
          ) : null}
          {end ? (
            <div class="noor-landing-timer">
              <p class="noor-eyebrow">{text(settings.urgency) ?? t(context, { en: "Offer ends in", bn: "অফার শেষ হবে" })}</p>
              <Countdown end={end} context={context} compact />
            </div>
          ) : text(settings.urgency) ? <p class="noor-urgency" {...editable(context, "urgency")}>{settings.urgency}</p> : null}
          {product.soldOut ? (
            <p class="noor-landing-soldout">{t(context, { en: "Sold out for now", bn: "আপাতত স্টক শেষ" })}</p>
          ) : (
            <a class="noor-button is-solid is-large noor-landing-cta" href={`#${orderId}`}><span {...editable(context, "cta_label")}>{cta}</span><Icon name="arrow" size={18} /></a>
          )}
          {badges.length > 0 ? (
            <ul class="noor-badges-row">
              {badges.map((badge) => (
                <li><Icon name={(ICON_NAMES as string[]).includes(badge.icon ?? "") ? badge.icon as IconName : "check"} size={20} /><span>{badge.text}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {product.soldOut ? null : (
        <div class="noor-landing-order" id={orderId}>
          <div class="noor-landing-order-head">
            <h2 class="noor-title" {...editable(context, "order_heading")}>{text(settings.order_heading) ?? t(context, { en: "Place your order", bn: "অর্ডার করুন" })}</h2>
            {text(settings.order_text) ? <p class="noor-lede" {...editable(context, "order_text")}>{settings.order_text}</p> : null}
          </div>
          <div class="noor-landing-order-body">
            <aside class="noor-landing-summary" aria-label={t(context, { en: "Your order", bn: "আপনার অর্ডার" })}>
              {product.image ? <Image image={product.image} sizes="120px" alt="" class="noor-landing-thumb" /> : null}
              <div>
                <p class="noor-landing-summary-title">{product.title}</p>
                <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
              </div>
              <ul class="noor-landing-assure">
                {/* The form places cash-on-delivery orders: always true here. */}
                <li><Icon name="cash" size={18} />{t(context, { en: "Pay cash on delivery", bn: "পণ্য হাতে পেয়ে মূল্য পরিশোধ" })}</li>
                {badges.map((badge) => (
                  <li><Icon name={(ICON_NAMES as string[]).includes(badge.icon ?? "") ? badge.icon as IconName : "check"} size={18} />{badge.text}</li>
                ))}
              </ul>
            </aside>
            <div class="noor-landing-form">
              <Checkout product={product} maxQuantity={settings.max_quantity} submitLabel={text(settings.submit_label) ?? undefined} />
            </div>
          </div>
        </div>
      )}
      {settings.sticky_bar && !product.soldOut ? (
        <Island name="landing-bar" hydrate="idle" props={{ target: orderId }} class="noor-landing-bar">
          <div class="noor-landing-bar-inner">
            <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="noor-price" />
            <a class="noor-button is-solid" href={`#${orderId}`}>{cta}</a>
          </div>
        </Island>
      ) : null}
    </section>
  );
}
