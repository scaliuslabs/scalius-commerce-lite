// Noor's storytelling sections: a scrolling marquee, a bento of categories,
// testimonials, promise icons, a brand story with numbers, questions (with
// FAQPage structured data), a video feature, a photo wall and a sign-up call.

import {
  Image,
  Island,
  editable,
  raw,
  t,
  type SectionProps,
  type StorefrontImage,
} from "@scalius/plugin-sdk/storefront";
import { ICON_NAMES, Icon, type IconName } from "../icons";
import { Button, SectionHead, Stars, cx, text } from "../ui";

export interface MarqueeSettings {
  items: Array<{ text: string | null }>;
  speed: string;
  style: string;
  separator: string;
}

export function Marquee({ settings }: SectionProps<MarqueeSettings>) {
  const items = settings.items.flatMap((item) => (text(item.text) ? [text(item.text)!] : []));
  if (items.length === 0) return null;
  const separator = settings.separator === "dot" ? "•" : settings.separator === "slash" ? "/" : "✦";
  const run = (hidden: boolean) => (
    <ul class="noor-marquee-run" aria-hidden={hidden ? "true" : undefined}>
      {items.map((item) => <li>{item}<span class="noor-marquee-sep" aria-hidden="true">{separator}</span></li>)}
    </ul>
  );
  return (
    <section class={cx("noor-marquee", `speed-${settings.speed}`, `style-${settings.style}`)}>
      <div class="noor-marquee-track">{run(false)}{run(true)}</div>
    </section>
  );
}

export interface BentoSettings {
  eyebrow: string | null;
  heading: string | null;
  tiles: Array<{ image: StorefrontImage | null; title: string | null; subtitle: string | null; link: string | null }>;
}

export function CategoryBento({ settings, context }: SectionProps<BentoSettings>) {
  const tiles = settings.tiles.filter((tile) => tile.image && text(tile.title)).slice(0, 5);
  if (tiles.length === 0) return null;
  return (
    <section class="noor-section noor-bento-section">
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} context={context} />
      <div class={cx("noor-bento", `count-${tiles.length}`)}>
        {tiles.map((tile, index) => {
          const body = (
            <>
              <Image image={tile.image} sizes={index === 0 ? "(min-width: 900px) 50vw, 100vw" : "(min-width: 900px) 25vw, 50vw"} class="noor-bento-img" alt="" />
              <span class="noor-bento-copy">
                <span class="noor-bento-title">{tile.title}</span>
                {text(tile.subtitle) ? <span class="noor-bento-sub">{tile.subtitle}</span> : null}
              </span>
            </>
          );
          return text(tile.link) ? <a class="noor-bento-tile" href={tile.link!}>{body}</a> : <div class="noor-bento-tile">{body}</div>;
        })}
      </div>
    </section>
  );
}

export interface TestimonialsSettings {
  eyebrow: string | null;
  heading: string | null;
  items: Array<{ quote: string | null; name: string | null; detail: string | null; rating: number | null; avatar: StorefrontImage | null }>;
}

export function Testimonials({ settings, context, instanceId }: SectionProps<TestimonialsSettings>) {
  const items = settings.items.filter((item) => text(item.quote) && text(item.name));
  if (items.length === 0) return null;
  return (
    <section class="noor-section noor-quotes">
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} align="center" context={context} />
      <Island name="slideshow" hydrate="visible" props={{ autoplay: false, interval: 6 }}>
        <ul class="noor-quote-track" id={`noor-quotes-${instanceId}`} data-track tabindex="0">
          {items.map((item) => (
            <li class="noor-quote" data-slide>
              {item.rating ? <Stars value={item.rating} label={t(context, { en: `${item.rating} of 5 stars`, bn: `৫-এ ${item.rating} তারা` })} /> : null}
              <blockquote><p>“{item.quote}”</p></blockquote>
              <div class="noor-quote-by">
                {item.avatar ? <Image image={item.avatar} alt="" class="noor-avatar" /> : <span class="noor-avatar is-initial" aria-hidden="true">{item.name!.slice(0, 1)}</span>}
                <span><strong>{item.name}</strong>{text(item.detail) ? <span>{item.detail}</span> : null}</span>
              </div>
            </li>
          ))}
        </ul>
        {items.length > 1 ? (
          <div class="noor-slides-ui is-inline" data-controls hidden>
            <button type="button" class="noor-round" data-prev aria-label={t(context, { en: "Previous", bn: "আগের" })}><span class="noor-flip"><Icon name="chevron" size={18} /></span></button>
            <button type="button" class="noor-round" data-next aria-label={t(context, { en: "Next", bn: "পরের" })}><Icon name="chevron" size={18} /></button>
          </div>
        ) : null}
      </Island>
    </section>
  );
}

export interface PromisesSettings {
  items: Array<{ icon: string | null; title: string | null; text: string | null }>;
  style: string;
}

export function Promises({ settings, context }: SectionProps<PromisesSettings>) {
  const items = settings.items.filter((item) => text(item.title));
  if (items.length === 0) return null;
  return (
    <section class={cx("noor-promises", `style-${settings.style}`)} aria-label={t(context, { en: "Our promises", bn: "আমাদের প্রতিশ্রুতি" })}>
      <ul>
        {items.map((item) => (
          <li>
            <span class="noor-promise-icon"><Icon name={(ICON_NAMES as string[]).includes(item.icon ?? "") ? item.icon as IconName : "check"} size={24} /></span>
            <span><strong>{item.title}</strong>{text(item.text) ? <span>{item.text}</span> : null}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface StorySettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  image_side: string;
  stats: Array<{ value: string | null; label: string | null }>;
  cta_label: string | null;
  cta_link: string | null;
}

export function Story({ settings, context }: SectionProps<StorySettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  const stats = settings.stats.filter((stat) => text(stat.value) && text(stat.label));
  const paragraphs = (settings.text ?? "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return (
    <section class={cx("noor-section noor-story", settings.image_side === "end" && "is-flipped")}>
      {settings.image ? <div class="noor-story-media"><Image image={settings.image} sizes="(min-width: 900px) 45vw, 100vw" class="noor-story-img" /></div> : null}
      <div class="noor-story-copy">
        {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
        <h2 class="noor-title" {...editable(context, "heading")}>{heading}</h2>
        {paragraphs.length > 0 ? <div class="noor-prose" {...editable(context, "text")}>{paragraphs.map((paragraph) => <p>{paragraph}</p>)}</div> : null}
        {stats.length > 0 ? (
          <dl class="noor-stats">
            {stats.map((stat) => <div><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}
          </dl>
        ) : null}
        {text(settings.cta_label) && text(settings.cta_link)
          ? <Button href={settings.cta_link!} variant="ghost" editableKey="cta_label" context={context}>{settings.cta_label}</Button>
          : null}
      </div>
    </section>
  );
}

export interface FaqSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  questions: Array<{ question: string | null; answer: string | null }>;
  structured_data: boolean;
}

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the element. */
function jsonLd(value: unknown) {
  return raw(JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"));
}

export function Faq({ settings, context }: SectionProps<FaqSettings>) {
  const questions = settings.questions.filter((entry) => text(entry.question) && text(entry.answer));
  if (questions.length === 0) return null;
  return (
    <section class="noor-section noor-faq">
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} context={context} />
      <div class="noor-faq-list">
        {questions.map((entry, index) => (
          <details class="noor-faq-item" open={index === 0}>
            <summary>{entry.question}<span class="noor-faq-mark" aria-hidden="true"><Icon name="plus" size={18} /></span></summary>
            <div class="noor-faq-answer"><p>{entry.answer}</p></div>
          </details>
        ))}
      </div>
      {settings.structured_data ? (
        <script type="application/ld+json">{jsonLd({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: questions.map((entry) => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
        })}</script>
      ) : null}
    </section>
  );
}

export interface VideoSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  video_url: string | null;
  poster: StorefrontImage | null;
  autoplay: boolean;
  cta_label: string | null;
  cta_link: string | null;
}

export function VideoFeature({ settings, context }: SectionProps<VideoSettings>) {
  const url = text(settings.video_url);
  if (!url && !settings.poster) return null;
  return (
    <section class="noor-section noor-video">
      <div class="noor-video-frame">
        {url ? (
          <video class="noor-video-el" src={url} poster={settings.poster?.url} preload="none" playsinline controls={!settings.autoplay}
            autoplay={settings.autoplay} muted={settings.autoplay} loop={settings.autoplay} />
        ) : <Image image={settings.poster} sizes="100vw" class="noor-video-el" />}
      </div>
      <div class="noor-video-copy">
        <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} context={context} />
        {text(settings.cta_label) && text(settings.cta_link)
          ? <Button href={settings.cta_link!} editableKey="cta_label" context={context}>{settings.cta_label}</Button>
          : null}
      </div>
    </section>
  );
}

export interface GallerySettings {
  heading: string | null;
  handle: string | null;
  link: string | null;
  images: Array<{ image: StorefrontImage | null; link: string | null }>;
}

export function Gallery({ settings, context }: SectionProps<GallerySettings>) {
  const images = settings.images.filter((entry) => entry.image).slice(0, 8);
  if (images.length === 0) return null;
  return (
    <section class="noor-section noor-gallery">
      <SectionHead heading={text(settings.heading)} link={text(settings.link)} linkLabel={text(settings.handle)} context={context} />
      <ul class="noor-gallery-grid">
        {images.map((entry) => (
          <li>
            {text(entry.link)
              ? <a href={entry.link!}><Image image={entry.image} sizes="(min-width: 900px) 25vw, 50vw" class="noor-gallery-img" /></a>
              : <Image image={entry.image} sizes="(min-width: 900px) 25vw, 50vw" class="noor-gallery-img" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface SignupSettings {
  heading: string | null;
  text: string | null;
  button: string | null;
  image: StorefrontImage | null;
}

export function SignupCall({ settings, context }: SectionProps<SignupSettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  return (
    <section class={cx("noor-section noor-signup", settings.image && "has-image")}>
      {settings.image ? <Image image={settings.image} sizes="(min-width: 900px) 40vw, 100vw" class="noor-signup-img" alt="" /> : null}
      <div class="noor-signup-copy">
        <h2 class="noor-title" {...editable(context, "heading")}>{heading}</h2>
        {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
        <Button href="/newsletter" editableKey="button" context={context}>{text(settings.button) ?? t(context, { en: "Sign up", bn: "সাইন আপ" })}</Button>
      </div>
    </section>
  );
}
