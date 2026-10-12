// The Noor header: rotating announcements, then one bar with the menu, the
// logo and the actions (logo centred between them, or first), mega menus on
// computers and a drawer on phones. On a landing page it can turn into a
// campaign header: the logo and one "Order now" button, nothing that leads
// away from the order. Menus, search and the drawer are native HTML (hover,
// focus and `popover`), so they work before any script; the one island marks
// the bar once the page scrolls and turns the announcements.

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
import { choice, cx, text, type Context } from "./ui";

export interface HeaderSettings {
  layout: string;
  sticky: boolean;
  transparent_home: boolean;
  menu_style: string;
  show_search: boolean;
  show_account: boolean;
  announcements: Array<{ text: string | null; link: string | null }>;
  landing_header: string;
  landing_label: string | null;
}

function Announcements({ items, context }: { items: Array<{ text: string; link: string | null }>; context: Context }) {
  if (items.length === 0) return null;
  return (
    <div class="noor-announce" role="region" aria-label={t(context, { en: "Announcements", bn: "ঘোষণা" })}>
      <ul class="noor-announce-list" data-announce-list>
        {items.map((item, index) => (
          <li data-active={index === 0 ? "" : undefined} aria-hidden={index === 0 ? undefined : "true"} inert={index !== 0}>
            {item.link ? <a href={item.link}>{item.text}<Icon name="arrow" size={13} /></a> : <span>{item.text}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Menu({ items, style }: { items: StorefrontMenuItem[]; style: string }) {
  return (
    <ul class="noor-nav-list">
      {items.map((item) => {
        const children = item.children;
        const deep = children.some((child) => child.children.length > 0);
        return (
          <li class={cx("noor-nav-item", children.length > 0 && "has-menu")}>
            <a class="noor-nav-link" href={item.url} aria-haspopup={children.length > 0 ? "true" : undefined}>
              <span>{item.title}</span>
              {children.length > 0 ? <Icon name="down" size={14} /> : null}
            </a>
            {children.length > 0 ? (
              style === "mega" && deep ? (
                <div class="noor-mega">
                  <div class="noor-mega-inner">
                    {children.map((child) => (
                      <div class="noor-mega-col">
                        <a class="noor-mega-head" href={child.url}>{child.title}</a>
                        {child.children.length > 0 ? <MenuLinks items={child.children} /> : null}
                      </div>
                    ))}
                    <a class="noor-mega-all" href={item.url}>{item.title}<Icon name="arrow" size={14} /></a>
                  </div>
                </div>
              ) : (
                <div class="noor-drop">
                  <ul>{children.map((child) => <li>
                    <a href={child.url}>{child.title}</a>
                    {child.children.length > 0 ? <MenuLinks items={child.children} /> : null}
                  </li>)}</ul>
                </div>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Keep every merchant menu level reachable, including compact desktop menus. */
function MenuLinks({ items }: { items: StorefrontMenuItem[] }) {
  return <ul>{items.map((item) => <li>
    <a href={item.url}>{item.title}</a>
    {item.children.length > 0 ? <MenuLinks items={item.children} /> : null}
  </li>)}</ul>;
}

function DrawerMenu({ items, context, nested = false }: { items: StorefrontMenuItem[]; context: Context; nested?: boolean }) {
  return (
    <ul class={nested ? undefined : "noor-drawer-list"}>
      {items.map((item) => (
        <li>
          {item.children.length > 0 ? (
            <details>
              <summary><span>{item.title}</span><Icon name="down" size={16} /></summary>
              <ul><li><a href={item.url}>{t(context, { en: `All ${item.title}`, bn: `সব ${item.title}` })}</a></li></ul>
              <DrawerMenu items={item.children} context={context} nested />
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
  const campaign = context.page.kind === "landing" && choice(settings.landing_header, ["full", "campaign"] as const, "campaign") === "campaign";
  const transparent = settings.transparent_home && context.page.kind === "home";
  const layout = choice(settings.layout, ["center", "start"] as const, "center");
  const logo = (
    <a class="noor-logo" href={data.routes.home} aria-label={data.store.name}>
      {data.store.logo ? <Image image={data.store.logo} alt={data.store.name} loading="eager" class="noor-logo-img" /> : <span class="noor-logo-text">{data.store.name}</span>}
    </a>
  );
  if (campaign) {
    return (
      <div class={cx("noor-header-shell", settings.sticky && "is-sticky")} style={{ "--noor-logo-width": `${data.store.logoWidth}px` }}>
        <Island name="header" hydrate="idle" class="noor-header-island">
          {announcements.length > 0 ? <Announcements items={announcements.slice(0, 1)} context={context} /> : null}
          <header class="noor-header is-campaign">
            <div class="noor-header-bar">
              {logo}
              <Island name="landing-link" hydrate="idle">
                <a class="noor-btn is-solid is-small" href={data.routes.search} data-noor-order-link
                  data-order-label={text(settings.landing_label) ?? t(context, { en: "Order now", bn: "অর্ডার করুন" })}>
                  {t(context, { en: "Shop", bn: "কেনাকাটা করুন" })}
                </a>
              </Island>
            </div>
          </header>
        </Island>
      </div>
    );
  }
  const searchLabel = t(context, { en: "Search", bn: "খুঁজুন" });
  return (
    <div class={cx("noor-header-shell", settings.sticky && "is-sticky", transparent && "is-transparent")} style={{ "--noor-logo-width": `${data.store.logoWidth}px` }}>
      <Island name="header" hydrate="idle" class="noor-header-island">
        <Announcements items={announcements} context={context} />
        <header class={cx("noor-header", `is-${layout}`)}>
          <div class="noor-header-bar">
            <div class="noor-header-start">
              <button type="button" class="noor-icon-btn noor-phone-only" popovertarget="noor-drawer" aria-label={t(context, { en: "Open menu", bn: "মেনু খুলুন" })}>
                <Icon name="menu" size={22} />
              </button>
              {layout === "center" && settings.show_search ? (
                <button type="button" class="noor-search-trigger noor-desk-only" popovertarget="noor-search">
                  <Icon name="search" size={18} /><span>{searchLabel}</span>
                </button>
              ) : null}
            </div>
            {logo}
            {/* Centred logo: the menu has its own row on computers, so any menu fits. */}
            <nav class="noor-nav noor-desk-only" aria-label={t(context, { en: "Main", bn: "প্রধান" })}>
              <Menu items={data.menu} style={choice(settings.menu_style, ["mega", "simple"] as const, "mega")} />
            </nav>
            <div class="noor-header-end">
              {settings.show_search ? (
                <button type="button" class={cx("noor-icon-btn", layout === "center" && "noor-phone-only")} popovertarget="noor-search" aria-label={searchLabel}>
                  <Icon name="search" size={21} />
                </button>
              ) : null}
              {settings.show_account ? (
                <a class="noor-icon-btn noor-desk-only" href={data.routes.account} aria-label={t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}>
                  <Icon name="user" size={21} />
                </a>
              ) : null}
              <a class="noor-icon-btn noor-cart-btn" href={data.routes.cart} {...openCart()} aria-label={t(context, { en: "Cart", bn: "কার্ট" })}>
                <Icon name="bag" size={21} />
                <CartCount class="noor-cart-count" />
              </a>
            </div>
          </div>
        </header>
      </Island>
      <div id="noor-drawer" popover="auto" class="noor-drawer" aria-label={t(context, { en: "Menu", bn: "মেনু" })}>
        <div class="noor-drawer-top">
          <span class="noor-drawer-title">{data.store.name}</span>
          <button type="button" class="noor-icon-btn" popovertarget="noor-drawer" popovertargetaction="hide" aria-label={t(context, { en: "Close menu", bn: "মেনু বন্ধ করুন" })}>
            <Icon name="close" size={22} />
          </button>
        </div>
        <form class="noor-field is-search" action={data.routes.search} method="get" role="search">
          <Icon name="search" size={18} />
          <input type="search" name={data.searchParam} placeholder={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })} aria-label={searchLabel} />
        </form>
        <nav aria-label={t(context, { en: "Main", bn: "প্রধান" })}><DrawerMenu items={data.menu} context={context} /></nav>
        <div class="noor-drawer-foot">
          <a href={data.routes.account}><Icon name="user" size={18} />{t(context, { en: "My account", bn: "আমার অ্যাকাউন্ট" })}</a>
        </div>
      </div>
      {settings.show_search ? (
        <div id="noor-search" popover="auto" class="noor-search" aria-label={searchLabel}>
          <div class="noor-search-inner">
            <form class="noor-field is-search is-large" action={data.routes.search} method="get" role="search">
              <Icon name="search" size={20} />
              <input type="search" name={data.searchParam} autofocus placeholder={t(context, { en: "What are you looking for?", bn: "আপনি কী খুঁজছেন?" })} aria-label={searchLabel} />
              <button type="button" class="noor-icon-btn" popovertarget="noor-search" popovertargetaction="hide" aria-label={t(context, { en: "Close search", bn: "সার্চ বন্ধ করুন" })}>
                <Icon name="close" size={20} />
              </button>
            </form>
            {data.categories.length > 0 ? (
              <div class="noor-search-suggest">
                <p class="noor-eyebrow">{t(context, { en: "Popular", bn: "জনপ্রিয়" })}</p>
                <ul>{data.categories.slice(0, 8).map((category) => <li><a href={category.url}>{category.title}</a></li>)}</ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
