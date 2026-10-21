/** @jsxImportSource @scalius/plugin-sdk/storefront */
// Compose's storefront module: components for other apps' units (card
// badges and lines, a buy-box line, a deferred wall), a header and a listing
// skin drawn from the header's and listing's facts, and one component that
// always throws. Every function is pure: data comes from the store.

import {
  Deferred,
  Filters,
  Image,
  Island,
  Pagination,
  Slot,
  Toolbar,
  accountLink,
  defineStorefront,
  openCart,
  t,
  whenSignedIn,
  whenSignedOut,
  type ComponentProps,
  type HeaderProps,
  type ListingMainProps,
  type StorefrontImage,
  type StorefrontProductCardData,
  type StorefrontProductPage,
} from "@scalius/plugin-sdk/storefront";

// ── On every card, whoever draws it ───────────────────────────────────────

function SellerBadge(props: ComponentProps<{ label: string }>) {
  if (props.target !== "product_card.badges") return null;
  const { product } = props.data as StorefrontProductCardData;
  return <span class="compose-badge" data-product={product.id}>{props.settings.label}</span>;
}

function CardLine(props: ComponentProps<{ text: string }>) {
  if (props.target !== "product_card.meta") return null;
  const { product } = props.data as StorefrontProductCardData;
  return <span class="compose-line" data-product={product.id}>{props.settings.text}</span>;
}

// ── The product page ──────────────────────────────────────────────────────

function ProductCode(props: ComponentProps) {
  if (props.target !== "product.buy_box.after") return null;
  const { product } = props.data as StorefrontProductPage;
  const codes = product.sku ? [product.sku] : product.variants.flatMap((variant) => (variant.sku ? [variant.sku] : []));
  const emi = product.installments;
  return (
    <dl class="compose-code">
      {codes.length > 0 ? <><dt>{t(props.context, { en: "Product code", bn: "পণ্য কোড" })}</dt><dd>{codes.join(", ")}</dd></> : null}
      {emi ? <><dt>EMI</dt><dd data-emi-months={String(emi.months)}>{emi.monthly.formatted} × {String(emi.months)}</dd></> : null}
    </dl>
  );
}

/** A heavy part below the fold: shipped in the page, laid out only when it nears the screen. */
function SpecWall(props: ComponentProps) {
  if (props.target !== "product.below") return null;
  const { product } = props.data as StorefrontProductPage;
  return (
    <section class="compose-wall">
      <h2>{t(props.context, { en: "In detail", bn: "বিস্তারিত" })}</h2>
      <Deferred minHeight="24rem">
        <Island name="wall" props={{ rows: product.media.length }}>
          <ul class="compose-wall-photos">
            {product.media.map((image) => <li><Image image={image} sizes="(min-width: 64rem) 25vw, 50vw" /></li>)}
          </ul>
        </Island>
      </Deferred>
    </section>
  );
}

function Broken(): never {
  throw new Error("compose: this component always fails");
}

// ── Skins ─────────────────────────────────────────────────────────────────

function Header({ data, settings, context }: HeaderProps<{ promo: StorefrontImage | null; promo_link: string | null }>) {
  const market = data.market;
  return (
    <header class="compose-header">
      <a class="compose-logo" href={data.routes.home}>{data.store.name}</a>
      <nav class="compose-menu">
        {data.menu.map((item) => (
          <a href={item.url} class="compose-menu-item">
            {item.image ? <Image image={item.image} sizes="48px" class="compose-menu-photo" /> : null}
            <span>{item.title}</span>
          </a>
        ))}
      </nav>
      <form class="compose-search" action={data.routes.search} method="get" role="search">
        {data.searchScopes && data.searchScopes.length > 0 ? (
          <select name={data.searchScopeParam ?? "category"} aria-label={t(context, { en: "Department", bn: "বিভাগ" })}>
            <option value="">{t(context, { en: "All", bn: "সব" })}</option>
            {data.searchScopes.map((scope) => <option value={scope.value}>{scope.title}</option>)}
          </select>
        ) : null}
        <input type="search" name={data.searchParam} aria-label={t(context, { en: "Search", bn: "খুঁজুন" })} />
        <button type="submit">{t(context, { en: "Search", bn: "খুঁজুন" })}</button>
      </form>
      <a href={data.routes.orders ?? data.routes.account} class="compose-orders" {...whenSignedIn()}>{t(context, { en: "Your orders", bn: "আপনার অর্ডার" })}</a>
      <a href={data.routes.account} class="compose-sign-in" {...whenSignedOut()} {...accountLink()}>{t(context, { en: "Sign in", bn: "সাইন ইন" })}</a>
      {data.routes.trackOrder ? <a href={data.routes.trackOrder} class="compose-track">{t(context, { en: "Track an order", bn: "অর্ডার ট্র্যাক করুন" })}</a> : null}
      {market?.selection ? (
        <form class="compose-market" method="post" action={market.selection.action}>
          <select name="country_code">
            {market.selection.countries.map((country) => <option value={country.code} selected={country.code === market.country}>{country.name} ({country.currency})</option>)}
          </select>
          <input type="hidden" name="return_to" value={market.selection.returnTo} />
          <button type="submit">{t(context, { en: "Change", bn: "বদলান" })}</button>
        </form>
      ) : null}
      {settings.promo ? (
        <a class="compose-promo" href={settings.promo_link ?? data.routes.search}><Image image={settings.promo} sizes="320px" /></a>
      ) : null}
      <a href={data.routes.cart} {...openCart()}>{t(context, { en: "Cart", bn: "কার্ট" })}</a>
      <Slot name="header.actions" />
    </header>
  );
}

function Listing({ data, context }: ListingMainProps) {
  return (
    <div class="compose-listing">
      <h1>{data.title}</h1>
      {data.children && data.children.length > 0 ? (
        <nav class="compose-departments" aria-label={t(context, { en: "Departments", bn: "বিভাগ" })}>
          {data.children.map((child) => (
            <a href={child.url}>{child.image ? <Image image={child.image} sizes="96px" /> : null}<span>{child.title}</span></a>
          ))}
        </nav>
      ) : null}
      <Filters />
      <Toolbar />
      <ul class="compose-results">{data.cards.map((card) => <li><a href={card.url}>{card.title}</a></li>)}</ul>
      <Pagination />
    </div>
  );
}

export default defineStorefront({
  components: {
    seller_badge: SellerBadge,
    card_line: CardLine,
    product_code: ProductCode,
    spec_wall: SpecWall,
    broken: Broken,
  },
  skins: { compose_header: Header, compose_listing: Listing },
});
