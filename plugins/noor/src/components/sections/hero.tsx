// Noor's heroes: an editorial split (a photo beside large type, with an
// optional rotating sticker) and a full-bleed slideshow that scrolls and
// snaps without script; its island adds autoplay, arrows and dots.

import { Image, Island, editable, t, type SectionProps, type StorefrontImage } from "@scalius/plugin-sdk/storefront";
import { Icon } from "../icons";
import { Button, cx, text } from "../ui";

export interface HeroEditorialSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  image_side: string;
  primary_label: string | null;
  primary_link: string | null;
  secondary_label: string | null;
  secondary_link: string | null;
  sticker: string | null;
  tone: string;
  height: string;
}

/** Circular text: the sticker's words around a ring, read once by screen readers. */
function Sticker({ words, id }: { words: string; id: string }) {
  const ring = `${words} • ${words} • `;
  return (
    <div class="noor-sticker" aria-hidden="true">
      <svg viewBox="0 0 100 100" width="112" height="112">
        <defs><path id={id} d="M50 50m-38 0a38 38 0 1 1 76 0a38 38 0 1 1-76 0" /></defs>
        <text><textPath href={`#${id}`}>{ring}</textPath></text>
      </svg>
      <span class="noor-sticker-core"><Icon name="sparkle" size={22} /></span>
    </div>
  );
}

export function HeroEditorial({ settings, context, instanceId }: SectionProps<HeroEditorialSettings>) {
  const heading = text(settings.heading);
  if (!heading && !settings.image) return null;
  return (
    <section class={cx("noor-hero-editorial", `tone-${settings.tone}`, `height-${settings.height}`, settings.image_side === "start" && "is-flipped")}>
      <div class="noor-hero-copy">
        {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
        {heading ? <h1 class="noor-display" {...editable(context, "heading")}>{heading}</h1> : null}
        {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
        <div class="noor-cta-row">
          {text(settings.primary_label) && text(settings.primary_link)
            ? <Button href={settings.primary_link!} editableKey="primary_label" context={context}>{settings.primary_label}</Button>
            : null}
          {text(settings.secondary_label) && text(settings.secondary_link)
            ? <Button href={settings.secondary_link!} variant="ghost" editableKey="secondary_label" context={context}>{settings.secondary_label}</Button>
            : null}
        </div>
      </div>
      <div class="noor-hero-media">
        {settings.image
          ? <Image image={settings.image} sizes="(min-width: 900px) 50vw, 100vw" loading="eager" class="noor-hero-img" />
          : <div class="noor-hero-fill" />}
        {text(settings.sticker) ? <Sticker words={settings.sticker!} id={`noor-ring-${instanceId}`} /> : null}
      </div>
    </section>
  );
}

export interface HeroSlideshowSettings {
  slides: Array<{ image: StorefrontImage | null; heading: string | null; text: string | null; label: string | null; link: string | null; align: string | null }>;
  autoplay: boolean;
  interval: number;
  height: string;
  overlay: string;
}

export function HeroSlideshow({ settings, context, instanceId }: SectionProps<HeroSlideshowSettings>) {
  const slides = settings.slides.filter((slide) => slide.image);
  if (slides.length === 0) return null;
  const id = `noor-slides-${instanceId}`;
  return (
    <section class={cx("noor-slideshow", `height-${settings.height}`, `overlay-${settings.overlay}`)}
      aria-roledescription="carousel" aria-label={t(context, { en: "Featured", bn: "বিশেষ" })}>
      <Island name="slideshow" hydrate="visible" props={{ autoplay: settings.autoplay && slides.length > 1, interval: settings.interval }}>
        <div class="noor-slides" id={id} data-track tabindex="0">
          {slides.map((slide, index) => (
            <div class={cx("noor-slide", `align-${slide.align ?? "start"}`)} role="group" aria-roledescription="slide"
              aria-label={`${index + 1} / ${slides.length}`} data-slide>
              <Image image={slide.image} sizes="100vw" loading={index === 0 ? "eager" : "lazy"} class="noor-slide-img" />
              <div class="noor-slide-copy">
                {text(slide.heading) ? (index === 0 ? <h1 class="noor-display">{slide.heading}</h1> : <h2 class="noor-display">{slide.heading}</h2>) : null}
                {text(slide.text) ? <p class="noor-lede">{slide.text}</p> : null}
                {text(slide.label) && text(slide.link) ? <a class="noor-button is-light" href={slide.link!}>{slide.label}<Icon name="arrow" size={18} /></a> : null}
              </div>
            </div>
          ))}
        </div>
        {slides.length > 1 ? (
          <div class="noor-slides-ui" data-controls hidden>
            <button type="button" class="noor-round" data-prev aria-controls={id} aria-label={t(context, { en: "Previous slide", bn: "আগের স্লাইড" })}>
              <span class="noor-flip"><Icon name="chevron" size={18} /></span>
            </button>
            <div class="noor-dots" data-dots>
              {slides.map((_, index) => <button type="button" class="noor-dot" data-dot={String(index)} aria-label={`${index + 1}`} />)}
            </div>
            <button type="button" class="noor-round" data-next aria-controls={id} aria-label={t(context, { en: "Next slide", bn: "পরের স্লাইড" })}>
              <Icon name="chevron" size={18} />
            </button>
          </div>
        ) : null}
      </Island>
    </section>
  );
}
