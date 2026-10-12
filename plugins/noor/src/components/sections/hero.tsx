// Noor's heroes. One photo hero in two layouts (words over the photo, or
// beside it) and a slideshow. Heights are bounded by the viewport and by a
// cap, so the first screen always shows the hero and the start of what
// follows; phones get their own crop (a separate phone photo when set).

import { Image, Island, editable, t, type SectionProps, type StorefrontImage } from "@scalius/plugin-sdk/storefront";
import { Icon } from "../icons";
import { Button, Section, choice, cx, text, type Context } from "../ui";

export interface HeroSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  phone_image: StorefrontImage | null;
  primary_label: string | null;
  primary_link: string | null;
  secondary_label: string | null;
  secondary_link: string | null;
  layout: string;
  position: string;
  height: string;
  scrim: string;
  tone: string;
}

function Photo({ image, phone, eager, sizes }: { image: StorefrontImage | null; phone: StorefrontImage | null; eager: boolean; sizes: string }) {
  if (!image && !phone) return <span class="noor-hero-blank" />;
  return (
    <picture>
      {image && phone ? <source media="(max-width: 47.99rem)" srcset={phone.srcset ?? phone.url} sizes="100vw" width={phone.width} height={phone.height} /> : null}
      <Image image={image ?? phone} sizes={sizes} loading={eager ? "eager" : "lazy"} class="noor-hero-img" />
    </picture>
  );
}

function Copy({ settings, context, light }: { settings: HeroSettings; context: Context; light: boolean }) {
  const primary = text(settings.primary_label) && text(settings.primary_link);
  const secondary = text(settings.secondary_label) && text(settings.secondary_link);
  return (
    <div class="noor-hero-copy">
      {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
      {text(settings.heading) ? <h2 class="noor-display" {...editable(context, "heading")}>{settings.heading}</h2> : null}
      {text(settings.text) ? <p class="noor-hero-text" {...editable(context, "text")}>{settings.text}</p> : null}
      {primary || secondary ? (
        <div class="noor-actions-row">
          {primary ? <Button href={settings.primary_link!} variant={light ? "light" : "solid"} size="large" editableKey="primary_label" context={context}>{settings.primary_label}</Button> : null}
          {secondary ? <Button href={settings.secondary_link!} variant="outline" size="large" editableKey="secondary_label" context={context}>{settings.secondary_label}</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Hero({ settings, context }: SectionProps<HeroSettings>) {
  const layout = choice(settings.layout, ["overlay", "split"] as const, "overlay");
  const height = choice(settings.height, ["s", "m", "l", "screen"] as const, "l");
  if (!settings.image && !settings.phone_image && !text(settings.heading)) return null;
  // Section placements do not expose their page position to the theme.
  const eager = true;
  if (layout === "split") {
    return (
      <Section name="hero" tone={settings.tone} space="none" bleed>
        <div class={cx("noor-hero is-split", `h-${height}`, choice(settings.position, ["start", "end"] as const, "start") === "end" && "is-flipped")}>
          <div class="noor-hero-media"><Photo image={settings.image} phone={settings.phone_image} eager={eager} sizes="(min-width: 768px) 50vw, 100vw" /></div>
          <div class="noor-hero-panel"><Copy settings={settings} context={context} light={false} /></div>
        </div>
      </Section>
    );
  }
  return (
    <Section name="hero" space="none" bleed>
      <div class={cx("noor-hero is-overlay", `h-${height}`, `at-${choice(settings.position, ["start", "center", "end"] as const, "start")}`,
        `scrim-${choice(settings.scrim, ["none", "soft", "strong"] as const, "soft")}`)}>
        <div class="noor-hero-media"><Photo image={settings.image} phone={settings.phone_image} eager={eager} sizes="100vw" /></div>
        <div class="noor-hero-over"><div class="noor-wrap"><Copy settings={settings} context={context} light /></div></div>
      </div>
    </Section>
  );
}

export interface SlideshowSettings {
  slides: Array<{
    image: StorefrontImage | null;
    phone_image: StorefrontImage | null;
    eyebrow: string | null;
    heading: string | null;
    text: string | null;
    label: string | null;
    link: string | null;
    position: string | null;
  }>;
  autoplay: boolean;
  interval: number;
  height: string;
  scrim: string;
}

export function Slideshow({ settings, context, instanceId }: SectionProps<SlideshowSettings>) {
  const slides = settings.slides.filter((slide) => slide.image || slide.phone_image);
  if (slides.length === 0) return null;
  const height = choice(settings.height, ["s", "m", "l", "screen"] as const, "l");
  const scrim = choice(settings.scrim, ["none", "soft", "strong"] as const, "soft");
  return (
    <Section name="slideshow" space="none" bleed label={t(context, { en: "Featured", bn: "বিশেষ" })}>
      <Island name="slideshow" hydrate="visible" props={{ autoplay: settings.autoplay, interval: settings.interval }} class="noor-slideshow-island">
        <div class={cx("noor-hero is-overlay is-slides", `h-${height}`, `scrim-${scrim}`)}>
          <ul class="noor-slides" data-track tabindex="0" aria-roledescription="carousel">
            {slides.map((slide, index) => {
              const label = text(slide.label);
              const link = text(slide.link);
              return (
                <li class={cx("noor-slide", `at-${choice(slide.position, ["start", "center", "end"] as const, "start")}`)} data-slide
                  aria-roledescription="slide" aria-label={`${index + 1} / ${slides.length}`} id={`${instanceId}-slide-${index}`}>
                  <div class="noor-hero-media">
                    <Photo image={slide.image} phone={slide.phone_image} eager={index === 0} sizes="100vw" />
                  </div>
                  <div class="noor-hero-over">
                    <div class="noor-wrap">
                      <div class="noor-hero-copy">
                        {text(slide.eyebrow) ? <p class="noor-eyebrow">{slide.eyebrow}</p> : null}
                        {text(slide.heading) ? (index === 0 ? <h2 class="noor-display">{slide.heading}</h2> : <p class="noor-display" role="heading" aria-level="2">{slide.heading}</p>) : null}
                        {text(slide.text) ? <p class="noor-hero-text">{slide.text}</p> : null}
                        {label && link ? <div class="noor-actions-row"><Button href={link} variant="light" size="large" context={context}>{label}</Button></div> : null}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {slides.length > 1 ? (
            <div class="noor-slides-nav" data-controls hidden>
              <button type="button" class="noor-round is-glass" data-prev aria-label={t(context, { en: "Previous slide", bn: "আগের স্লাইড" })}><Icon name="back" size={18} /></button>
              <ol class="noor-dots">
                {slides.map((_, index) => (
                  <li><button type="button" data-dot={String(index)} aria-current={index === 0 ? "true" : "false"}
                    aria-label={t(context, { en: `Slide ${index + 1}`, bn: `স্লাইড ${index + 1}` })} /></li>
                ))}
              </ol>
              <button type="button" class="noor-round is-glass" data-next aria-label={t(context, { en: "Next slide", bn: "পরের স্লাইড" })}><Icon name="arrow" size={18} /></button>
              {settings.autoplay ? (
                <button type="button" class="noor-round is-glass" data-autoplay-toggle
                  data-pause-label={t(context, { en: "Pause slideshow", bn: "স্লাইডশো থামান" })}
                  data-play-label={t(context, { en: "Play slideshow", bn: "স্লাইডশো চালান" })}
                  aria-label={t(context, { en: "Pause slideshow", bn: "স্লাইডশো থামান" })}>
                  <span data-pause-icon><svg class="noor-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 5v14M15 5v14" /></svg></span>
                  <span data-play-icon hidden><Icon name="play" size={18} /></span>
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Island>
    </Section>
  );
}
