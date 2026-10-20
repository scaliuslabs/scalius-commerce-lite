// Volt's own sections, for what the store's sections cannot draw as the
// source store does: a trust strip of five facts (the store's holds four),
// the offer cards of the offers page, and one wide promo banner.

import { Image, t, type SectionProps, type StorefrontImage } from "@scalius/plugin-sdk/storefront";
import { TrustStrip } from "./skins";
import { Section, SectionHead, cx, list, text, whole } from "./ui";

interface TrustSettings {
  items: Array<{ icon: string | null; title: string | null; detail: string | null }>;
}

export function TrustSection({ settings, context }: SectionProps<TrustSettings>) {
  const items = list(settings.items).flatMap((item) => (text(item.title) ? [{ title: text(item.title)!, detail: text(item.detail) ?? "", icon: text(item.icon) }] : []));
  return <TrustStrip items={items} context={context} />;
}

interface OfferSettings {
  heading: string | null;
  subtitle: string | null;
  columns: number;
  offers: Array<{ image: StorefrontImage | null; title: string | null; text: string | null; badge: string | null; link: string | null }>;
}

export function OfferCards({ settings, context }: SectionProps<OfferSettings>) {
  const offers = list(settings.offers).filter((offer) => offer.image || text(offer.title));
  if (offers.length === 0) return null;
  return (
    <Section name="offers">
      <SectionHead title={text(settings.heading)} subtitle={text(settings.subtitle)} />
      <ul class="volt-offers" style={{ "--volt-cols": String(whole(settings.columns, 1, 4, 3)) }}>
        {offers.map((offer) => {
          const body = (
            <>
              <span class="volt-offer-media">{offer.image ? <Image image={offer.image} sizes="(min-width: 64rem) 33vw, 100vw" /> : null}</span>
              {text(offer.badge) ? <span class="volt-pill">{text(offer.badge)}</span> : null}
              <span class="volt-offer-body">
                {text(offer.title) ? <strong>{text(offer.title)}</strong> : null}
                {text(offer.text) ? <small>{text(offer.text)}</small> : null}
                {text(offer.link) ? <span class="volt-more">{t(context, { en: "View offer", bn: "অফার দেখুন" })}</span> : null}
              </span>
            </>
          );
          return <li>{text(offer.link) ? <a class="volt-offer" href={text(offer.link)!}>{body}</a> : <div class="volt-offer">{body}</div>}</li>;
        })}
      </ul>
    </Section>
  );
}

interface BannerSettings {
  image: StorefrontImage | null;
  phone_image: StorefrontImage | null;
  alt: string | null;
  link: string | null;
}

export function PromoBanner({ settings }: SectionProps<BannerSettings>) {
  const image = settings.image ?? settings.phone_image;
  if (!image) return null;
  const alt = text(settings.alt) ?? image.alt;
  const picture = (
    <>
      <Image image={{ ...image, alt }} class={cx(settings.phone_image && settings.image && "volt-desk-img")} sizes="100vw" />
      {settings.phone_image && settings.image ? <Image image={{ ...settings.phone_image, alt }} class="volt-phone-img" sizes="100vw" /> : null}
    </>
  );
  return (
    <Section name="promo">
      {text(settings.link) ? <a class="volt-promo" href={text(settings.link)!}>{picture}</a> : <div class="volt-promo">{picture}</div>}
    </Section>
  );
}
