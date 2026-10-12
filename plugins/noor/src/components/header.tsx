// The Noor header: an announcement rotator, then a three-part bar (the menu,
// the logo, the actions) in a split or classic arrangement, with mega menus
// on computers and a drawer on phones. Menus, search and the drawer are
// native HTML (hover and focus, `popover`), so they work before any script;
// the one island only marks the bar once the page scrolls.

import {
  CartCount,
  Image,
  Island,
  openCart,
  t,
  type HeaderProps,
  type StorefrontMenuItem,
} from "@scalius/plugin-sdk/storefront";
import { Icon } from "./icons";
import { cx, text, type Context } from "./ui";

export interface HeaderSettings {
  layout: string;
  sticky: boolean;
  overlay_home: boolean;
  menu_style: string;
  show_search: boolean;
  announcements: Array<{ text: string | null; link: string | null }>;
}

function Announcements({ items, context }: { items: Array<{ text: string; link: string | null }>; context: Context }) {
  if (items.length === 0) return null;
  // One shows at a time; the header island turns them every few seconds.
  return (
    <div class="noor-announce" role="region" aria-label={t(context, { en: "Announcements", bn: "ঘোষণা" })}>
      <ul class="noor-announce-list" data-announce-list>
        {items.map((item, index) => (
          <li class="noor-announce-item" data-active={index === 0 ? "" : undefined} aria-hidden={index === 0 ? undefined : "true"}>
            {item.link ? <a href={item.link}>{item.text}</a> : item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MegaMenu({ items, style }: { items: StorefrontMenuItem[]; style: string }) {
  return (
    <ul class="noor-nav-list">
      {items.map((item) => (
        <li class={cx("noor-nav-item", item.children.length > 0 && "has-children")}>
          <a class="noor-nav-link" href={item.url}>
            {item.title}
            {item.children.length > 0 ? <Icon name="down" size={14} /> : null}
          </a>
          {item.children.length > 0 ? (
            <div class={cx("noor-mega", style === "simple" && "is-simple")}>
              <div class="noor-mega-inner">
                {item.children.map((child) => (
                  <div class="noor-mega-col">
                    <a class="noor-mega-head" href={child.url}>{child.title}</a>
                    {child.children.length > 0 ? (
                      <ul>{child.children.map((leaf) => <li><a href={leaf.url}>{leaf.title}</a></li>)}</ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function DrawerMenu({ items }: { items: StorefrontMenuItem[] }) {
  return (
    <ul class="noor-drawer-list">
      {items.map((item) => (
        <li>
          {item.children.length > 0 ? (
            <details class="noor-drawer-group">
              <summary>{item.title}<Icon name="down" size={16} /></summary>
              <ul>
                <li><a href={item.url}>{item.title}</a></li>
                {item.children.map((child) => <li><a href={child.url}>{child.title}</a></li>)}
              </ul>
            </details>
          ) : <a href={item.url}>{item.title}</a>}
        </li>
      ))}
    </ul>
  );
}

export function Header({ data, settings, context }: HeaderProps<HeaderSettings>) {
  const own = settings.announcements.flatMap((item) => (text(item.text) ? [{ text: text(item.text)!, link: text(item.link) }] : []));
  const announcements = own.length > 0 ? own : data.announcement ? [{ text: data.announcement.text, link: data.announcement.url }] : [];
  const overlay = settings.overlay_home && context.page.kind === "home";
  const logo = data.store.logo ? (
    <Image image={data.store.logo} alt={data.store.name} loading="eager" class="noor-logo-img" />
  ) : <span class="noor-logo-text">{data.store.name}</span>;
  return (
    <div class={cx("noor-header-shell", settings.sticky && "is-sticky", overlay && "is-overlay")}
      style={{ "--noor-logo-width": `${data.store.logoWidth}px` }}>
      <Island name="header" hydrate="load" class="noor-header-island">
        <Announcements items={announcements} context={context} />
        <header class={cx("noor-header", `layout-${settings.layout}`)}>
          <div class="noor-header-inner">
            <button type="button" class="noor-icon-button noor-only-mobile" popovertarget="noor-drawer"
              aria-label={t(context, { en: "Open menu", bn: "মেনু খুলুন" })}>
              <Icon name="menu" />
            </button>
            <nav class="noor-nav noor-only-desktop" aria-label={t(context, { en: "Main", bn: "প্রধান" })}>
              <MegaMenu items={data.menu} style={settings.menu_style} />
            </nav>
            <a class="noor-logo" href={data.routes.home} aria-label={data.store.name}>{logo}</a>
            <div class="noor-actions">
              {settings.show_search ? (
                <button type="button" class="noor-icon-button" popovertarget="noor-search" aria-label={t(context, { en: "Search", bn: "খুঁজুন" })}>
                  <Icon name="search" />
                </button>
              ) : null}
              <a class="noor-icon-button noor-only-desktop" href={data.routes.account} aria-label={t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}>
                <Icon name="user" />
              </a>
              <a class="noor-icon-button noor-cart-button" href={data.routes.cart} {...openCart()} aria-label={t(context, { en: "Cart", bn: "কার্ট" })}>
                <Icon name="bag" />
                <CartCount class="noor-cart-count" />
              </a>
            </div>
          </div>
        </header>
      </Island>
      <div id="noor-drawer" popover="auto" class="noor-drawer" aria-label={t(context, { en: "Menu", bn: "মেনু" })}>
        <div class="noor-drawer-top">
          <span class="noor-drawer-title">{data.store.name}</span>
          <button type="button" class="noor-icon-button" popovertarget="noor-drawer" popovertargetaction="hide"
            aria-label={t(context, { en: "Close menu", bn: "মেনু বন্ধ করুন" })}>
            <Icon name="close" />
          </button>
        </div>
        <form class="noor-drawer-search" action={data.routes.search} method="get" role="search">
          <Icon name="search" size={18} />
          <input type="search" name={data.searchParam} placeholder={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })}
            aria-label={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })} />
        </form>
        <nav aria-label={t(context, { en: "Main", bn: "প্রধান" })}><DrawerMenu items={data.menu} /></nav>
        <a class="noor-drawer-account" href={data.routes.account}><Icon name="user" size={18} />{t(context, { en: "My account", bn: "আমার অ্যাকাউন্ট" })}</a>
      </div>
      {settings.show_search ? (
        <div id="noor-search" popover="auto" class="noor-search-panel" aria-label={t(context, { en: "Search", bn: "খুঁজুন" })}>
          <form class="noor-search-form" action={data.routes.search} method="get" role="search">
            <Icon name="search" />
            <input type="search" name={data.searchParam} autofocus placeholder={t(context, { en: "What are you looking for?", bn: "আপনি কী খুঁজছেন?" })}
              aria-label={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })} />
            <button type="submit" class="noor-button is-solid is-small">{t(context, { en: "Search", bn: "খুঁজুন" })}</button>
          </form>
          {data.categories.length > 0 ? (
            <div class="noor-search-suggest">
              <p class="noor-eyebrow">{t(context, { en: "Popular categories", bn: "জনপ্রিয় ক্যাটাগরি" })}</p>
              <ul>{data.categories.slice(0, 8).map((category) => <li><a href={category.url}>{category.title}</a></li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
