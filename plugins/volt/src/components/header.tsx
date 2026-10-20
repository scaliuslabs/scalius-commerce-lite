// The Volt header, as the source store lays it out: one white bar with the
// logo, a wide search field, quick links with icons (Offers, Pre-order,
// Blog, Compare), the cart and the account; under it a full-width category
// bar whose items open a mega panel of their subcategories, with one promo
// photo per panel when the merchant gives one. Phones get the logo, the
// search and the cart in the bar, a drawer of the same tree, and (unless the
// store draws its own tab bar) a bottom bar: Home, Category, Offer, Account.
//
// The tree is the store's category tree (`data.categories`) by default, or
// the header menu. Menus follow the store's disclosure pattern (a button
// with `aria-expanded` per item); the drawer is a native popover.

import {
  CartCount,
  Image,
  accountLink,
  asset,
  menuDrawer,
  openCart,
  stickyHeader,
  t,
  type HeaderProps,
  type StorefrontMenuItem,
} from "@scalius/plugin-sdk/storefront";
import { Icon, isIconName, type IconName } from "./icons";
import { choice, cx, list, text, type Context } from "./ui";

export interface HeaderSettings {
  menu_source: string;
  search_placeholder: string | null;
  quick_links: Array<{ label: string | null; link: string | null; icon: string | null }>;
  mega_promos: Array<{ menu: string | null; image_url: string | null; link: string | null; alt: string | null }>;
  offer_link: string | null;
  bottom_bar: boolean;
  sticky: boolean;
}

const linked = (item: StorefrontMenuItem) => item.url !== "" && item.url !== "#";

function ItemLink({ item, class: className }: { item: StorefrontMenuItem; class?: string }) {
  return linked(item) ? <a class={className} href={item.url}>{item.title}</a> : <span class={className}>{item.title}</span>;
}

/** A promo photo for a top item, by its title (case aside). Only https photos (the store's media). */
function promoFor(settings: HeaderSettings, title: string) {
  const key = title.trim().toLowerCase();
  const promo = list(settings.mega_promos).find((entry) => text(entry.menu)?.toLowerCase() === key);
  const url = text(promo?.image_url);
  if (!promo || !url || !/^https?:\/\//.test(url)) return null;
  return { url, link: text(promo.link), alt: text(promo.alt) ?? title };
}

function CategoryBar({ items, settings, context }: { items: StorefrontMenuItem[]; settings: HeaderSettings; context: Context }) {
  return (
    <nav class="volt-cats volt-desk" aria-label={t(context, { en: "Categories", bn: "ক্যাটাগরি" })}>
      <ul class="volt-wrap volt-cats-list" data-nav-overflow>
        {items.map((item, index) => {
          const panel = `volt-mega-${index}`;
          const has = item.children.length > 0;
          const promo = has ? promoFor(settings, item.title) : null;
          const deep = item.children.some((child) => child.children.length > 0);
          return (
            <li class={cx("volt-cats-item", has && "has-menu")} data-nav-index={String(index)} data-disclosure-item={has ? "" : undefined}>
              {linked(item)
                ? <a class="volt-cats-link" href={item.url} data-nav-link>{item.title}</a>
                : <button type="button" class="volt-cats-link" data-nav-link {...(has ? { "data-disclosure": "popup", "aria-expanded": "false", "aria-controls": panel } : {})}>{item.title}</button>}
              {has && linked(item) ? (
                <button type="button" class="volt-cats-toggle" data-disclosure="popup" aria-expanded="false" aria-controls={panel}>
                  <span class="volt-sr">{t(context, { en: `${item.title} menu`, bn: `${item.title} মেনু` })}</span>
                  <Icon name="down" size={14} />
                </button>
              ) : null}
              {has ? (
                <div class={cx("volt-mega", deep && "is-deep", promo && "has-promo")} id={panel} hidden>
                  <div class="volt-mega-links">
                    {deep ? item.children.map((child) => (
                      <div class="volt-mega-col">
                        <ItemLink item={child} class="volt-mega-head" />
                        {child.children.length > 0 ? <ul>{child.children.map((leaf) => <li><ItemLink item={leaf} /></li>)}</ul> : null}
                      </div>
                    )) : <ul class="volt-mega-flat">{item.children.map((child) => <li><ItemLink item={child} /></li>)}</ul>}
                  </div>
                  {promo ? (
                    <a class="volt-mega-promo" href={promo.link ?? (linked(item) ? item.url : "#")}>
                      <img src={promo.url} alt={promo.alt} loading="lazy" decoding="async" width="280" height="280" />
                    </a>
                  ) : null}
                  {linked(item) ? <a class="volt-mega-all" href={item.url}>{t(context, { en: `All ${item.title}`, bn: `সব ${item.title}` })}<Icon name="chevron" size={14} /></a> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function DrawerTree({ items, context, nested = false }: { items: StorefrontMenuItem[]; context: Context; nested?: boolean }) {
  return (
    <ul class={nested ? "volt-drawer-sub" : "volt-drawer-list"}>
      {items.map((item) => (
        <li>
          {item.children.length > 0 ? (
            <details>
              <summary><span>{item.title}</span><Icon name="down" size={16} /></summary>
              {linked(item) ? <a class="volt-drawer-all" href={item.url}>{t(context, { en: `All ${item.title}`, bn: `সব ${item.title}` })}</a> : null}
              <DrawerTree items={item.children} context={context} nested />
            </details>
          ) : <ItemLink item={item} />}
        </li>
      ))}
    </ul>
  );
}

const DEFAULT_LINKS: Array<{ label: string; link: string; icon: IconName }> = [
  { label: "Offers", link: "/offers", icon: "gift" },
  { label: "Pre-order", link: "/pre-order", icon: "clock" },
  { label: "Blog", link: "/blog", icon: "blog" },
];

export function Header({ data, settings, context }: HeaderProps<HeaderSettings>) {
  const source = choice(settings.menu_source, ["categories", "menu"] as const, "categories");
  const tree = source === "menu" && data.menu.length > 0 ? data.menu : data.categories.length > 0 ? data.categories : data.menu;
  const own = list(settings.quick_links).flatMap((item) => {
    const label = text(item.label);
    const link = text(item.link);
    return label && link ? [{ label, link, icon: isIconName(item.icon ?? "") ? item.icon as IconName : "chevron" as IconName }] : [];
  });
  const quick = own.length > 0 ? own : DEFAULT_LINKS;
  const searchLabel = t(context, { en: "Search", bn: "খুঁজুন" });
  const placeholder = text(settings.search_placeholder) ?? t(context, { en: "Search...", bn: "খুঁজুন..." });
  const offers = text(settings.offer_link) ?? "/offers";
  const showBottomBar = settings.bottom_bar && !data.phoneNavigation?.tabBar;
  const logo = (
    <a class="volt-logo" href={data.routes.home} aria-label={data.store.name}>
      {data.store.logo
        ? <Image image={data.store.logo} alt={data.store.name} loading="eager" class="volt-logo-img" />
        : <img class="volt-logo-img" src={asset(context, "public/logo.svg")} alt={data.store.name} width="220" height="48" />}
    </a>
  );
  return (
    <div class={cx("volt-header-shell", settings.sticky && "is-sticky")} {...(settings.sticky ? stickyHeader() : {})} style={{ "--volt-logo-width": `${data.store.logoWidth}px` }}>
      <header class="volt-header">
        <div class="volt-wrap volt-bar">
          <button type="button" class="volt-icon-btn volt-phone" popovertarget="volt-drawer" aria-label={t(context, { en: "Open menu", bn: "মেনু খুলুন" })}>
            <Icon name="menu" size={22} />
          </button>
          {logo}
          <form class="volt-search" action={data.routes.search} method="get" role="search">
            <input type="search" name={data.searchParam} placeholder={placeholder} aria-label={searchLabel} autocomplete="off" />
            <button type="submit" class="volt-search-btn" aria-label={searchLabel}><Icon name="search" size={20} /></button>
          </form>
          <nav class="volt-quick volt-desk" aria-label={t(context, { en: "Quick links", bn: "দ্রুত লিংক" })}>
            {quick.map((item) => (
              <a class="volt-quick-link" href={item.link}><span class="volt-quick-icon"><Icon name={item.icon} size={20} /></span><span>{item.label}</span></a>
            ))}
          </nav>
          <a class="volt-quick-link volt-cart" href={data.routes.cart} {...openCart()} aria-label={t(context, { en: "Cart", bn: "কার্ট" })}>
            <span class="volt-quick-icon"><Icon name="cart" size={22} /><CartCount class="volt-cart-count" /></span>
            <span class="volt-desk">{t(context, { en: "Cart", bn: "কার্ট" })}</span>
          </a>
          <a class="volt-quick-link volt-account volt-desk" href={data.routes.account} {...accountLink()}>
            <span class="volt-quick-icon"><Icon name="user" size={22} /></span>
            <span>{t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}</span>
          </a>
        </div>
      </header>
      {tree.length > 0 ? <CategoryBar items={tree} settings={settings} context={context} /> : null}
      <div id="volt-drawer" popover="auto" class="volt-drawer" aria-label={t(context, { en: "Menu", bn: "মেনু" })} {...menuDrawer()}>
        <div class="volt-drawer-top">
          {logo}
          <button type="button" class="volt-icon-btn" popovertarget="volt-drawer" popovertargetaction="hide" aria-label={t(context, { en: "Close menu", bn: "মেনু বন্ধ করুন" })}>
            <Icon name="close" size={22} />
          </button>
        </div>
        <nav aria-label={t(context, { en: "Categories", bn: "ক্যাটাগরি" })}><DrawerTree items={tree} context={context} /></nav>
        <ul class="volt-drawer-quick">
          {quick.map((item) => <li><a href={item.link}><Icon name={item.icon} size={18} />{item.label}</a></li>)}
        </ul>
      </div>
      {showBottomBar ? (
        <nav class="volt-bottom volt-phone" aria-label={t(context, { en: "Shortcuts", bn: "শর্টকাট" })}>
          <a href={data.routes.home}><Icon name="home" size={22} /><span>{t(context, { en: "Home", bn: "হোম" })}</span></a>
          <button type="button" popovertarget="volt-drawer"><Icon name="grid" size={22} /><span>{t(context, { en: "Category", bn: "ক্যাটাগরি" })}</span></button>
          <a href={offers}><Icon name="gift" size={22} /><span>{t(context, { en: "Offer", bn: "অফার" })}</span></a>
          <a href={data.routes.account} {...accountLink()}><Icon name="user" size={22} /><span>{t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}</span></a>
        </nav>
      ) : null}
    </div>
  );
}
