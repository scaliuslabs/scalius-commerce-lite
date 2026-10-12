/** @jsxImportSource @scalius/plugin-sdk/storefront */
// The Studio theme's storefront module: every component is a function of its
// settings and data that returns HTML. No client code here: the carousel's
// buttons are an island (islands/carousel.ts); the cart drawer, cart count
// and quick add are the store's own behaviours, named by attributes.

import {
  CartCount,
  Image,
  Island,
  Price,
  asset,
  defineStorefront,
  editable,
  openCart,
  quickAdd,
  t,
  type FooterProps,
  type HeaderProps,
  type ProductCardProps,
  type SectionProps,
  type StorefrontImage,
  type StorefrontProductCard,
  type StorefrontRenderContext,
} from "@scalius/plugin-sdk/storefront";

// ── Chrome ────────────────────────────────────────────────────────────────

function Header({ data, settings, context }: HeaderProps<{ sticky: boolean; show_search: boolean }>) {
  return (
    <header class={["studio-header", settings.sticky && "is-sticky"]}>
      {data.announcement ? (
        <p class="studio-announcement">
          {data.announcement.url ? <a href={data.announcement.url}>{data.announcement.text}</a> : data.announcement.text}
        </p>
      ) : null}
      <div class="studio-bar">
        <a class="studio-logo" href={data.routes.home} aria-label={data.store.name}>
          {data.store.logo
            ? <Image image={data.store.logo} alt={data.store.name} loading="eager" class="studio-logo-image" />
            : <span>{data.store.name}</span>}
        </a>
        <nav class="studio-nav" aria-label={t(context, { en: "Main", bn: "প্রধান" })}>
          {data.menu.map((item) => (
            item.children.length > 0 ? (
              <details class="studio-menu">
                <summary>{item.title}</summary>
                <ul>{item.children.map((child) => <li><a href={child.url}>{child.title}</a></li>)}</ul>
              </details>
            ) : <a href={item.url}>{item.title}</a>
          ))}
        </nav>
        <div class="studio-actions">
          {settings.show_search ? (
            <form class="studio-search" action={data.routes.search} method="get" role="search">
              <input type="search" name={data.searchParam} placeholder={t(context, { en: "Search", bn: "খুঁজুন" })} aria-label={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })} />
            </form>
          ) : null}
          <a href={data.routes.account} class="studio-icon-link">{t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}</a>
          <a href={data.routes.cart} class="studio-cart" {...openCart()}>
            {t(context, { en: "Cart", bn: "কার্ট" })} <CartCount class="studio-cart-count" />
          </a>
        </div>
      </div>
    </header>
  );
}

function Footer({ data, settings }: FooterProps<{ tagline: string | null }>) {
  return (
    <footer class="studio-footer">
      <div class="studio-footer-brand">
        <strong>{data.store.name}</strong>
        {settings.tagline ? <p>{settings.tagline}</p> : null}
        {data.store.email ? <a href={`mailto:${data.store.email}`}>{data.store.email}</a> : null}
      </div>
      {data.menus.map((menu) => (
        <nav aria-label={menu.title}>
          <h2>{menu.title}</h2>
          <ul>{menu.items.map((item) => <li><a href={item.url}>{item.title}</a></li>)}</ul>
        </nav>
      ))}
      <p class="studio-footer-legal">
        © {data.year} {data.store.name}
        {data.policies.map((policy) => <> · <a href={policy.url}>{policy.title}</a></>)}
      </p>
    </footer>
  );
}

// ── The card ──────────────────────────────────────────────────────────────

function Card({ product, context, ratio = "portrait", showRating = true, eager = false }: {
  product: StorefrontProductCard;
  context: StorefrontRenderContext;
  ratio?: string;
  showRating?: boolean;
  eager?: boolean;
}) {
  return (
    <article class={["studio-card", `ratio-${ratio}`, product.soldOut && "is-sold-out"]}>
      <a class="studio-card-media" href={product.url} tabindex="-1" aria-hidden="true">
        <Image image={product.image} sizes="(min-width: 1024px) 22vw, (min-width: 640px) 33vw, 50vw" loading={eager ? "eager" : "lazy"} alt="" />
        {product.percentOff ? <span class="studio-badge">-{product.percentOff}%</span> : null}
      </a>
      <h3 class="studio-card-title"><a href={product.url}>{product.title}</a></h3>
      <Price price={product.price} compareAt={product.compareAt} from={product.priceVaries} context={context} class="studio-price" />
      {showRating && product.rating ? <p class="studio-rating">★ {product.rating.average.toFixed(1)} ({product.rating.count})</p> : null}
      {product.soldOut
        ? <p class="studio-sold-out">{t(context, { en: "Sold out", bn: "স্টক শেষ" })}</p>
        : <a class="studio-add" {...quickAdd(product)}>{product.quickAdd ? t(context, { en: "Add to cart", bn: "কার্টে যোগ করুন" }) : t(context, { en: "Choose options", bn: "অপশন বাছুন" })}</a>}
    </article>
  );
}

function ProductCardSlot({ data, settings, context }: ProductCardProps<{ ratio: string; show_rating: boolean }>) {
  return <Card product={data.product} context={context} ratio={settings.ratio} showRating={settings.show_rating} eager={data.aboveFold} />;
}

// ── Sections ──────────────────────────────────────────────────────────────

function Hero({ settings, context }: SectionProps<{
  heading: string | null; text: string | null; image: StorefrontImage | null; cta_label: string | null; cta_link: string | null; align: string;
}>) {
  return (
    <section class={["studio-hero", `align-${settings.align}`, !settings.image && "no-image"]}>
      <Image image={settings.image} sizes="100vw" loading="eager" class="studio-hero-image" alt="" />
      <div class="studio-hero-copy">
        {settings.heading ? <h1 {...editable(context, "heading")}>{settings.heading}</h1> : null}
        {settings.text ? <p {...editable(context, "text")}>{settings.text}</p> : null}
        {settings.cta_label && settings.cta_link
          ? <a class="studio-button" href={settings.cta_link} {...editable(context, "cta_label")}>{settings.cta_label}</a>
          : null}
      </div>
    </section>
  );
}

function Featured({ settings, context }: SectionProps<{ heading: string | null; products: StorefrontProductCard[] }>) {
  if (settings.products.length === 0) return null;
  return (
    <section class="studio-featured">
      {settings.heading ? <h2 {...editable(context, "heading")}>{settings.heading}</h2> : null}
      <Island name="carousel" hydrate="visible">
        <div class="studio-row" data-carousel-track>
          {settings.products.map((product) => <Card product={product} context={context} />)}
        </div>
        <img src={asset(context, "mark.svg")} alt="" width="16" height="16" class="studio-mark" />
      </Island>
    </section>
  );
}

function Features({ settings, context }: SectionProps<{
  heading: string | null; items: Array<{ title: string | null; text: string | null; icon: StorefrontImage | null }>;
}>) {
  if (settings.items.length === 0) return null;
  return (
    <section class="studio-features">
      {settings.heading ? <h2 {...editable(context, "heading")}>{settings.heading}</h2> : null}
      <ul>
        {settings.items.map((item) => (
          <li>
            <Image image={item.icon} alt="" class="studio-feature-icon" />
            <h3>{item.title}</h3>
            {item.text ? <p>{item.text}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Faq({ settings, context }: SectionProps<{ heading: string | null; questions: Array<{ question: string | null; answer: string | null }> }>) {
  if (settings.questions.length === 0) return null;
  return (
    <section class="studio-faq">
      {settings.heading ? <h2 {...editable(context, "heading")}>{settings.heading}</h2> : null}
      {settings.questions.map((entry) => (
        <details>
          <summary>{entry.question}</summary>
          <p>{entry.answer}</p>
        </details>
      ))}
    </section>
  );
}

export default defineStorefront({
  sections: { hero: Hero, featured: Featured, features: Features, faq: Faq },
  slots: { "studio-header": Header, "studio-footer": Footer, "studio-card": ProductCardSlot },
});
