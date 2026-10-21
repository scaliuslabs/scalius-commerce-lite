/** @jsxImportSource @scalius/plugin-sdk/storefront */
import { describe, expect, it } from "vitest";
import { STOREFRONT_COMPONENT_ABI } from "@scalius/shared/plugins/storefront-protocol";
import {
  BuyForm,
  CartCount,
  Deferred,
  OrderForm,
  Reviews,
  whenSignedIn,
  whenSignedOut,
  Image,
  Island,
  Price,
  accountLink,
  asset,
  defineStorefront,
  editable,
  formatDate,
  formatMoney,
  formatNumber,
  html,
  plural,
  quickAdd,
  raw,
  searchOpener,
  stickyHeader,
  storeTime,
  storefrontDefinitionOf,
  t,
  type HeaderProps,
  type ProductCardProps,
  type SectionProps,
} from "./index";
import { checkSkinHtml, fixtureContext, fixtureProductCard, renderHeader, renderProductCard, renderSection, storefrontShown } from "./testing";

const Hero = ({ settings, context }: SectionProps<{ heading: string; text: string | null }>) => (
  <section class="hero" data-kind={context.page.kind}>
    <h2 {...editable(context, "heading")}>{settings.heading}</h2>
    {settings.text ? <p>{settings.text}</p> : null}
  </section>
);

const Card = ({ data, context }: ProductCardProps) => (
  <article class={["card", data.product.soldOut && "sold-out"]}>
    <a href={data.product.url}>
      <Image image={data.product.image} sizes="50vw" loading={data.aboveFold ? "eager" : "lazy"} />
      <h3>{data.product.title}</h3>
    </a>
    <Price price={data.product.price} compareAt={data.product.compareAt} context={context} />
    <a {...quickAdd(data.product)}>Add</a>
  </article>
);

const Header = ({ data }: HeaderProps) => (
  <header>
    <a href={data.routes.home}>{data.store.name}</a>
    <nav>{data.menu.map((item) => <a href={item.url}>{item.title}</a>)}</nav>
    <button type="button" data-cart-open=""><CartCount /></button>
  </header>
);

const storefront = defineStorefront({
  sections: { hero: Hero, broken: () => { throw new Error("boom"); } },
  skins: { "clean-card": Card, "clean-header": Header },
});

describe("storefront JSX", () => {
  it("keeps host action fallback routes and sticky geometry opt-in in rendered markup", () => {
    const app = defineStorefront({ skins: { header: ({ data }: HeaderProps) => (
      <header {...stickyHeader()}>
        <a href={data.routes.search} {...searchOpener()}>Search</a>
        <a href={data.routes.account} {...accountLink()}>Account</a>
      </header>
    ) } });
    expect(renderHeader(app, "header", {})).toBe('<header data-sticky-header=""><a href="/search" data-search-open="">Search</a><a href="/account" data-account-link="">Account</a></header>');
  });

  it("escapes text and attribute values", () => {
    const out = renderSection(storefront, "hero", { heading: `<script>alert("x")</script>`, text: `a & b "c"` });
    expect(out).toBe(`<section class="hero" data-kind="home"><h2>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h2><p>a &amp; b &quot;c&quot;</p></section>`);
  });

  it("marks editable text only in the editor's preview", () => {
    expect(renderSection(storefront, "hero", { heading: "Hi", text: null })).not.toContain("data-theme-field");
    expect(renderSection(storefront, "hero", { heading: "Hi", text: null }, { context: { preview: true } }))
      .toContain(`<h2 data-theme-field="heading">Hi</h2>`);
  });

  it("joins class lists, renders void elements and drops false attributes", () => {
    const out = (<div class={["a", false, "b"]} hidden={false} data-x={1}><br /><input disabled /></div>).value;
    expect(out).toBe(`<div class="a b" data-x="1"><br><input disabled></div>`);
  });

  it("writes style objects and refuses event handlers and bad names", () => {
    expect((<p style={{ marginTop: 4, "--accent": "#fff", color: null }} />).value).toBe(`<p style="margin-top:4;--accent:#fff"></p>`);
    expect(() => <button onClick={() => {}} />).toThrow(/island/);
    expect(() => <p {...{ "bad name": "x" }} />).toThrow(/Invalid attribute/);
  });

  it("keeps raw text elements to trusted markup", () => {
    expect((<style>{raw(".a{color:red}")}</style>).value).toBe("<style>.a{color:red}</style>");
    expect(() => <style>{"}</style><script>"}</style>).toThrow(/raw/);
  });

  it("renders html templates with escaped interpolations", () => {
    expect(html`<p title="${`"q"`}">${"<b>"}${raw("<i>ok</i>")}${[1, 2]}</p>`.value).toBe(`<p title="&quot;q&quot;">&lt;b&gt;<i>ok</i>12</p>`);
  });
});

describe("primitives", () => {
  it("draws a card with its image renditions, price and quick add", () => {
    const out = renderProductCard(storefront, "clean-card");
    expect(out).toContain(`srcset="https://media.example.com/shirt-480.webp 480w, https://media.example.com/shirt-960.webp 960w"`);
    expect(out).toContain(`sizes="50vw"`);
    expect(out).toContain(`width="960" height="1200"`);
    expect(out).toContain(`loading="lazy"`);
    expect(out).toContain(`<span data-price-current>৳1,200</span>`);
    expect(out).toContain(`<s data-price-regular>৳1,500</s>`);
    expect(out).toContain(`<a href="/products/linen-shirt" data-card-quick-add="">Add</a>`);
  });

  it("does not offer quick add for a product that needs its page", () => {
    expect(renderProductCard(storefront, "clean-card", {}, { quickAdd: false })).toContain(`<a href="/products/linen-shirt">Add</a>`);
  });

  it("loads the first image eagerly with high priority", () => {
    const out = Image({ image: fixtureProductCard().image, loading: "eager" }).value;
    expect(out).toContain(`loading="eager"`);
    expect(out).toContain(`fetchpriority="high"`);
    expect(out).toContain(`decoding="sync"`);
    expect(Image({ image: null }).value).toBe("");
  });

  it("lets an eager image load at normal or low priority", () => {
    const image = fixtureProductCard().image;
    const normal = Image({ image, loading: "eager", fetchpriority: "auto" }).value;
    expect(normal).toContain(`loading="eager"`);
    expect(normal).not.toContain("fetchpriority");
    expect(normal).toContain(`decoding="async"`);
    const low = Image({ image, loading: "eager", fetchpriority: "low" }).value;
    expect(low).toContain(`fetchpriority="low"`);
    expect(Image({ image }).value).not.toContain("fetchpriority");
  });

  it("prices in Bangla with a from-price and no struck price when not discounted", () => {
    const out = Price({ price: { amountMinor: 90000, currency: "BDT", formatted: "৳900" }, compareAt: { amountMinor: 90000, currency: "BDT", formatted: "৳900" }, from: true, context: fixtureContext({ store: { name: "x", currency: "BDT", locale: "bn-BD", language: "bn", timeZone: "Asia/Dhaka" } }) }).value;
    expect(out).toContain("৳900 থেকে");
    expect(out).not.toContain("data-price-regular");
  });

  it("places islands with JSON props and fallback markup", () => {
    const out = Island({ name: "carousel", props: { a: `"</script>` }, hydrate: "idle", children: <p>Slides</p> }).value;
    expect(out).toBe(`<scalius-island data-island="carousel" data-hydrate="idle" data-props="{&quot;a&quot;:&quot;\\&quot;&lt;/script&gt;&quot;}"><p>Slides</p></scalius-island>`);
  });

  it("defers markup into a template the store shows as is, holding its space", () => {
    const out = (
      <Deferred minHeight="24rem">
        <Island name="wall" hydrate="load"><p>Reviews</p></Island>
      </Deferred>
    ).value;
    expect(out).toBe('<scalius-deferred data-hydrate="visible" style="display:block;min-block-size:24rem"><template>'
      + '<scalius-island data-island="wall" data-hydrate="load"><p>Reviews</p></scalius-island></template></scalius-deferred>');
    expect(storefrontShown(out, "acme.theme")).toEqual({ html: out, dropped: 0 });
    expect(Deferred({ hydrate: "interaction", children: "x" }).value).toBe('<scalius-deferred data-hydrate="interaction" style="display:block"><template>x</template></scalius-deferred>');
    expect(Deferred({ minHeight: "calc(100vh - 4rem)" }).value).toContain('style="display:block;min-block-size:calc(100vh - 4rem)"');
    expect(() => Deferred({ minHeight: "1rem;background:red" })).toThrow(/CSS length/);
  });

  it("drops an embed inside deferred markup, and the packer's rule sees it", () => {
    const out = <section><Deferred><Reviews /></Deferred></section>;
    expect(storefrontShown(out.value, "acme.theme")).toEqual({ html: '<section><scalius-deferred data-hydrate="visible" style="display:block"><template></template></scalius-deferred></section>', dropped: 1 });
    expect(checkSkinHtml("product_main", (<div><BuyForm /></div>).value)).toEqual([]);
    expect(checkSkinHtml("product_main", (<div><Deferred><BuyForm /></Deferred></div>).value)).toEqual([
      'A product_main skin must place <scalius-embed kind="buy_form"> (the SDK\'s <BuyForm />); without it the store draws its own.',
      "1 embed(s) render nothing here: product_main allows buy_form, reviews, recommendations, gallery.",
    ]);
  });

  it("marks signed-in and signed-out parts, which the store keeps", () => {
    const out = (
      <nav>
        <a href="/account" {...whenSignedIn()}>My account</a>
        <a href="/account" {...whenSignedOut()}>Sign in</a>
      </nav>
    ).value;
    expect(out).toBe('<nav><a href="/account" data-scalius-when="signed-in">My account</a><a href="/account" data-scalius-when="signed-out">Sign in</a></nav>');
    expect(storefrontShown(out, "acme.theme")).toEqual({ html: out, dropped: 0 });
  });

  it("names public files and the cart count", () => {
    expect(asset(fixtureContext(), "/fonts/a.woff2")).toBe("/_x/acme.theme/0123456789abcdef/public/fonts/a.woff2");
    expect(renderHeader(storefront, "clean-header")).toContain(`<button type="button" data-cart-open=""><span data-scalius-cart-count aria-live="polite"></span></button>`);
  });
});

describe("defineStorefront", () => {
  it("answers each job alone: one failure never hides the others", () => {
    const reply = storefront.render({
      abi: STOREFRONT_COMPONENT_ABI,
      context: fixtureContext(),
      jobs: [
        { id: "a", kind: "section", type: "broken", instanceId: "s1", settings: {} },
        { id: "b", kind: "section", type: "hero", instanceId: "s2", settings: { heading: "Ok", text: null } },
        { id: "c", kind: "section", type: "missing", instanceId: "s3", settings: {} },
      ],
    });
    expect(reply.results).toEqual([
      { id: "a", error: "Error: boom" },
      { id: "b", html: `<section class="hero" data-kind="home"><h2>Ok</h2></section>` },
      { id: "c", error: "Error: No component for section missing." },
    ]);
  });

  it("refuses another ABI", () => {
    const reply = storefront.render({ abi: 2 as never, context: fixtureContext(), jobs: [{ id: "a", kind: "section", type: "hero", instanceId: "s", settings: {} }] });
    expect(reply.results[0]).toEqual({ id: "a", error: "Unsupported render ABI 2." });
  });

  it("exposes its definition for the packer", () => {
    expect(Object.keys(storefrontDefinitionOf(storefront)?.sections ?? {})).toEqual(["hero", "broken"]);
    expect(storefrontDefinitionOf({ abi: 1 })).toBeNull();
  });

  it("refuses async components", () => {
    const asyncModule = defineStorefront({ sections: { slow: async () => "x" } as never });
    expect(() => renderSection(asyncModule, "slow")).toThrow(/synchronously/);
  });
});

describe("words, numbers and dates in the page's locale", () => {
  const store = (language: string, locale: string, currency = "USD", timeZone = "America/New_York") => ({ store: { name: "x", currency, locale, language, timeZone } });

  it("picks words by exact tag, then language, then English", () => {
    const words = { en: "Shop", bn: "কিনুন", pt: "Comprar", "pt-BR": "Compre" };
    expect(t(store("pt-BR", "pt-BR"), words)).toBe("Compre");
    expect(t(store("pt-PT", "pt-PT"), words)).toBe("Comprar");
    expect(t(store("fr", "fr-FR"), words)).toBe("Shop");
    expect(t(store("bn", "bn-BD"), { en: "Shop", bn: "" })).toBe("Shop");
  });

  it("writes numbers, plurals and money as the store does", () => {
    const reviews = { en: { one: "# review", other: "# reviews" }, bn: { other: "#টি রিভিউ" } };
    expect(plural(store("en", "en-US"), 1, reviews)).toBe("1 review");
    expect(plural(store("en", "en-US"), 1200, reviews)).toBe("1,200 reviews");
    expect(plural(store("bn", "bn-BD"), 12, reviews)).toBe("১২টি রিভিউ");
    expect(formatNumber(store("en", "en-BD"), 1234567)).toBe("12,34,567");
    expect(formatNumber(store("bn", "bn-BD"), 4.5, { minimumFractionDigits: 1 })).toBe("৪.৫");
    expect(formatMoney(store("en", "en-US"), { amountMinor: 125050, currency: "USD" })).toBe("$1,250.50");
    expect(formatMoney(store("en", "en-US"), { amountMinor: 1250, currency: "JPY" })).toBe("¥1,250");
    expect(formatMoney(store("bn", "bn-BD"), { amountMinor: 175000, currency: "BDT" })).toBe("৳১,৭৫০");
  });

  it("reads dates and merchant wall times in the store's time zone", () => {
    expect(formatDate(store("en", "en-US"), Date.UTC(2026, 0, 1, 3), { dateStyle: "medium" })).toBe("Dec 31, 2025");
    expect(storeTime(store("en", "en-US"), "2026-07-01", 9, 30)).toBe(Date.UTC(2026, 6, 1, 13, 30));
    expect(storeTime(store("en", "en-US"), "2026-02-30")).toBeNull();
  });

  it("embeds the order form by product id, never by a URL a canonical path can change", () => {
    expect(OrderForm({ product: fixtureProductCard({ id: "prod_9", url: "/products/another" }) }).value).toBe('<scalius-embed kind="order_form" data-product="prod_9"></scalius-embed>');
    expect(OrderForm({ product: null }).value).toBe("");
  });
});
