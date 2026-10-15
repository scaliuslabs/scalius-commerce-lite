// Noor's storytelling sections: a scrolling marquee, promises, an image with
// text (a brand story with numbers), reviews (quotes or screenshots), a
// rich text block, questions (with FAQPage structured data), a video, a
// photo wall and a sign-up call.

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
import { Button, Rail, Section, SectionHead, Stars, choice, cx, ratingLabel, text, type Context } from "../ui";

function iconOf(value: unknown): IconName {
  return typeof value === "string" && (ICON_NAMES as string[]).includes(value) ? value as IconName : "check";
}

function paragraphs(value: string | null): string[] {
  return (value ?? "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

// ── Marquee ──────────────────────────────────────────────────────────────

export interface MarqueeSettings {
  items: Array<{ text: string | null }>;
  speed: string;
  style: string;
  separator: string;
}

export function Marquee({ settings, context }: SectionProps<MarqueeSettings>) {
  const items = settings.items.flatMap((item) => (text(item.text) ? [text(item.text)!] : []));
  if (items.length === 0) return null;
  const separator = settings.separator === "dot" ? "•" : settings.separator === "slash" ? "/" : "✦";
  // Enough copies to fill the widest screen; the second half repeats the first for a seamless loop.
  const copies = Math.max(2, Math.ceil(8 / items.length));
  const run = (hidden: boolean) => (
    <ul class="noor-marquee-run" aria-hidden={hidden ? "true" : undefined}>
      {Array.from({ length: copies }, (_, copy) => items.map((item) => (
        <li aria-hidden={copy > 0 && !hidden ? "true" : undefined}>{item}<span class="noor-marquee-sep" aria-hidden="true">{separator}</span></li>
      )))}
    </ul>
  );
  return (
    <section class={cx("noor-marquee", `speed-${choice(settings.speed, ["slow", "normal", "fast"] as const, "normal")}`, `style-${choice(settings.style, ["solid", "plain", "outline"] as const, "solid")}`)}
      aria-label={t(context, { en: "Highlights", bn: "হাইলাইট" })}>
      <div class="noor-marquee-track">{run(false)}{run(true)}</div>
    </section>
  );
}

// ── Promises ─────────────────────────────────────────────────────────────

export interface PromisesSettings {
  eyebrow: string | null;
  heading: string | null;
  items: Array<{ icon: string | null; title: string | null; text: string | null }>;
  style: string;
  tone: string;
  spacing: string;
}

export function Promises({ settings, context }: SectionProps<PromisesSettings>) {
  const items = settings.items.filter((item) => text(item.title));
  if (items.length === 0) return null;
  const style = choice(settings.style, ["strip", "cards", "centered"] as const, "strip");
  return (
    <Section name="promises" tone={settings.tone} space={settings.spacing} label={text(settings.heading) ? null : t(context, { en: "Our promises", bn: "আমাদের প্রতিশ্রুতি" })}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} align={style === "strip" ? "start" : "center"} context={context} />
      <ul class={cx("noor-promise-list", `is-${style}`, `count-${Math.min(items.length, 6)}`)}>
        {items.map((item) => (
          <li class="noor-promise">
            <span class="noor-promise-icon"><Icon name={iconOf(item.icon)} size={22} /></span>
            <span class="noor-promise-copy"><strong>{item.title}</strong>{text(item.text) ? <span>{item.text}</span> : null}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── Image with text ──────────────────────────────────────────────────────

export interface StorySettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  image: StorefrontImage | null;
  image_side: string;
  stats: Array<{ value: string | null; label: string | null }>;
  points: Array<{ text: string | null }>;
  cta_label: string | null;
  cta_link: string | null;
  tone: string;
  spacing: string;
}

export function Story({ settings, context }: SectionProps<StorySettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  const stats = settings.stats.filter((stat) => text(stat.value) && text(stat.label));
  const points = (settings.points ?? []).flatMap((point) => (text(point.text) ? [text(point.text)!] : []));
  const body = paragraphs(settings.text);
  return (
    <Section name="story" tone={settings.tone} space={settings.spacing}>
      <div class={cx("noor-split", !settings.image && "is-text", settings.image_side === "end" && "is-flipped")}>
        {settings.image ? <div class="noor-split-media"><Image image={settings.image} sizes="(min-width: 768px) 50vw, 100vw" class="noor-cover" /></div> : null}
        <div class="noor-split-copy">
          {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
          <h2 class="noor-h2" {...editable(context, "heading")}>{heading}</h2>
          {body.length > 0 ? <div class="noor-prose" {...editable(context, "text")}>{body.map((paragraph) => <p>{paragraph}</p>)}</div> : null}
          {points.length > 0 ? <ul class="noor-checks">{points.map((point) => <li><Icon name="check" size={16} />{point}</li>)}</ul> : null}
          {stats.length > 0 ? (
            <dl class="noor-stats">{stats.map((stat) => <div><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>
          ) : null}
          {text(settings.cta_label) && text(settings.cta_link) ? (
            <div class="noor-actions-row"><Button href={settings.cta_link!} variant="ink" editableKey="cta_label" context={context} icon>{settings.cta_label}</Button></div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

// ── Rich text ────────────────────────────────────────────────────────────

export interface RichTextSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  cta_label: string | null;
  cta_link: string | null;
  align: string;
  size: string;
  tone: string;
  spacing: string;
}

export function RichText({ settings, context }: SectionProps<RichTextSettings>) {
  const heading = text(settings.heading);
  const body = paragraphs(settings.text);
  if (!heading && body.length === 0) return null;
  const align = choice(settings.align, ["start", "center"] as const, "center");
  return (
    <Section name="richtext" tone={settings.tone} space={settings.spacing}>
      <div class={cx("noor-richtext", `is-${align}`, `size-${choice(settings.size, ["m", "l"] as const, "m")}`)}>
        {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
        {heading ? <h2 class="noor-h2" {...editable(context, "heading")}>{heading}</h2> : null}
        {body.length > 0 ? <div class="noor-prose" {...editable(context, "text")}>{body.map((paragraph) => <p>{paragraph}</p>)}</div> : null}
        {text(settings.cta_label) && text(settings.cta_link) ? (
          <div class="noor-actions-row"><Button href={settings.cta_link!} editableKey="cta_label" context={context}>{settings.cta_label}</Button></div>
        ) : null}
      </div>
    </Section>
  );
}

// ── Reviews ──────────────────────────────────────────────────────────────

export interface TestimonialsSettings {
  eyebrow: string | null;
  heading: string | null;
  summary: string | null;
  items: Array<{ quote: string | null; name: string | null; detail: string | null; rating: number | null; photo: StorefrontImage | null }>;
  style: string;
  tone: string;
  spacing: string;
}

function Review({ item, context }: { item: TestimonialsSettings["items"][number]; context: Context }) {
  return (
    <li class="noor-review" data-slide>
      <figure>
        {item.photo ? <Image image={item.photo} sizes="(min-width: 768px) 30vw, 80vw" alt={item.photo.alt} class="noor-review-photo" /> : null}
        {item.rating ? <Stars value={item.rating} label={ratingLabel(context, item.rating)} /> : null}
        {text(item.quote) ? <blockquote><p>{item.quote}</p></blockquote> : null}
        <figcaption>
          <span class="noor-avatar" aria-hidden="true">{item.name!.slice(0, 1)}</span>
          <span><strong>{item.name}</strong>{text(item.detail) ? <span>{item.detail}</span> : null}</span>
        </figcaption>
      </figure>
    </li>
  );
}

export function Testimonials({ settings, context }: SectionProps<TestimonialsSettings>) {
  const items = settings.items.filter((item) => (text(item.quote) || item.photo) && text(item.name));
  if (items.length === 0) return null;
  const style = choice(settings.style, ["row", "grid"] as const, "row");
  const heading = text(settings.heading);
  const list = <ul class={cx("noor-reviews", `is-${style}`)} data-track tabindex={style === "row" ? "0" : undefined}>{items.map((item) => <Review item={item} context={context} />)}</ul>;
  return (
    <Section name="testimonials" tone={settings.tone} space={settings.spacing}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={heading} context={context}>
        {text(settings.summary) ? <p class="noor-review-summary"><span aria-hidden="true">★★★★★</span> <span {...editable(context, "summary")}>{settings.summary}</span></p> : null}
      </SectionHead>
      {style === "row" ? <Rail label={heading ?? t(context, { en: "Reviews", bn: "রিভিউ" })} context={context}>{list}</Rail> : list}
    </Section>
  );
}

// ── Questions ────────────────────────────────────────────────────────────

export interface FaqSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  questions: Array<{ question: string | null; answer: string | null }>;
  contact_label: string | null;
  contact_link: string | null;
  structured_data: boolean;
  tone: string;
  spacing: string;
}

/** JSON for a `<script type="application/ld+json">`: nothing in it can close the element. */
function jsonLd(value: unknown) {
  return raw(JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"));
}

export function Faq({ settings, context }: SectionProps<FaqSettings>) {
  const questions = settings.questions.filter((entry) => text(entry.question) && text(entry.answer));
  if (questions.length === 0) return null;
  return (
    <Section name="faq" tone={settings.tone} space={settings.spacing}>
      <div class="noor-faq">
        <div class="noor-faq-head">
          <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} context={context} />
          {text(settings.contact_label) && text(settings.contact_link) ? (
            <Button href={settings.contact_link!} variant="outline" editableKey="contact_label" context={context} icon>{settings.contact_label}</Button>
          ) : null}
        </div>
        <div class="noor-faq-list">
          {questions.map((entry, index) => (
            <details class="noor-faq-item" open={index === 0}>
              <summary><span>{entry.question}</span><span class="noor-faq-mark" aria-hidden="true"><Icon name="plus" size={18} /></span></summary>
              <div class="noor-faq-answer">{paragraphs(entry.answer).map((paragraph) => <p>{paragraph}</p>)}</div>
            </details>
          ))}
        </div>
      </div>
      {settings.structured_data ? (
        <script type="application/ld+json">{jsonLd({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: questions.map((entry) => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
        })}</script>
      ) : null}
    </Section>
  );
}

// ── Video ────────────────────────────────────────────────────────────────

export interface VideoSettings {
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  video_url: string | null;
  poster: StorefrontImage | null;
  autoplay: boolean;
  layout: string;
  cta_label: string | null;
  cta_link: string | null;
  tone: string;
  spacing: string;
}

export function VideoFeature({ settings, context }: SectionProps<VideoSettings>) {
  const url = text(settings.video_url);
  if (!url && !settings.poster) return null;
  const layout = choice(settings.layout, ["wide", "split"] as const, "wide");
  const video = url ? (
    <video class="noor-cover" src={url} poster={settings.poster?.url} preload="none" playsinline
      controls muted={settings.autoplay} loop={settings.autoplay}
      aria-label={text(settings.heading) ?? t(context, { en: "Video", bn: "ভিডিও" })} />
  ) : null;
  const frame = (
    <div class="noor-video-frame">
      {video ? (settings.autoplay ? <Island name="video" hydrate="visible">{video}</Island> : video)
        : <Image image={settings.poster} sizes="100vw" class="noor-cover" />}
    </div>
  );
  const copy = (
    <>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} body={text(settings.text)} align={layout === "wide" ? "center" : "start"} context={context} />
      {text(settings.cta_label) && text(settings.cta_link)
        ? <div class={cx("noor-actions-row", layout === "wide" && "is-center")}><Button href={settings.cta_link!} editableKey="cta_label" context={context}>{settings.cta_label}</Button></div>
        : null}
    </>
  );
  return (
    <Section name="video" tone={settings.tone} space={settings.spacing}>
      {layout === "split"
        ? <div class="noor-split is-video"><div class="noor-split-media">{frame}</div><div class="noor-split-copy">{copy}</div></div>
        : <div class="noor-video-wide">{copy}{frame}</div>}
    </Section>
  );
}

// ── Photo wall ───────────────────────────────────────────────────────────

export interface GallerySettings {
  eyebrow: string | null;
  heading: string | null;
  handle: string | null;
  link: string | null;
  images: Array<{ image: StorefrontImage | null; link: string | null }>;
  tone: string;
  spacing: string;
}

export function Gallery({ settings, context }: SectionProps<GallerySettings>) {
  const images = settings.images.filter((entry) => entry.image).slice(0, 12);
  if (images.length === 0) return null;
  return (
    <Section name="gallery" tone={settings.tone} space={settings.spacing}>
      <SectionHead eyebrow={text(settings.eyebrow)} heading={text(settings.heading)} link={text(settings.link)} linkLabel={text(settings.handle)} context={context} />
      <ul class={cx("noor-wall", `count-${images.length}`)}>
        {images.map((entry) => {
          const photo = <Image image={entry.image} sizes="(min-width: 1024px) 16vw, 33vw" class="noor-cover" />;
          return <li>{text(entry.link) ? <a href={entry.link!} aria-label={text(entry.image?.alt) ? undefined : t(context, { en: "Open gallery link", bn: "গ্যালারির লিংক খুলুন" })}>{photo}</a> : photo}</li>;
        })}
      </ul>
    </Section>
  );
}

// ── Sign-up call ─────────────────────────────────────────────────────────

export interface SignupSettings {
  image?: StorefrontImage | null;
  eyebrow: string | null;
  heading: string | null;
  text: string | null;
  button: string | null;
  link: string | null;
  tone: string;
  spacing: string;
}

export function SignupCall({ settings, context }: SectionProps<SignupSettings>) {
  const heading = text(settings.heading);
  if (!heading) return null;
  return (
    <Section name="signup" space={settings.spacing}>
      <div class={cx("noor-callout", settings.image && "has-image", `is-${choice(settings.tone, ["soft", "ink", "accent"] as const, "soft")}`)}>
        {settings.image ? <Image image={settings.image} alt="" class="noor-callout-image noor-cover" sizes="(min-width: 768px) 50vw, 100vw" /> : null}
        <div class="noor-callout-copy">
          {text(settings.eyebrow) ? <p class="noor-eyebrow" {...editable(context, "eyebrow")}>{settings.eyebrow}</p> : null}
          <h2 class="noor-h2" {...editable(context, "heading")}>{heading}</h2>
          {text(settings.text) ? <p class="noor-lede" {...editable(context, "text")}>{settings.text}</p> : null}
          <div class="noor-actions-row">
            <Button href={text(settings.link) ?? "/newsletter"} variant={settings.tone === "soft" || !settings.tone ? "solid" : "light"} editableKey="button" context={context} icon>
              {text(settings.button) ?? t(context, { en: "Sign up", bn: "সাইন আপ" })}
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}
