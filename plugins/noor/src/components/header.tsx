// The Noor header: rotating announcements, then one bar with the menu, the
// logo and the actions (logo centred between them, or first), mega menus on
// computers (the roots past the row in a "More" dropdown) and a drawer on
// phones. Links to the page itself carry `aria-current="page"` and the
// links of the section it is in `aria-current="true"`, as the store's own
// menus mark them. On a landing page it can turn into a
// campaign header: the logo and one "Order now" button, nothing that leads
// away from the order. Menus follow the store's disclosure pattern (a button
// with `aria-expanded` per menu; click, Enter, Escape, arrow keys and hover
// intent come from the store's nav-disclosure script, and hover or focus
// opens them before it runs). Search and the drawer are native `popover`s.
// The drawer follows the theme's phone navigation: an accordion, or one
// level at a time; with Bottom tabs the store draws its tab bar, whose menu
// tab opens this drawer (`menuDrawer()`). The one island marks the bar once
// the page scrolls and turns the announcements.

import {
  CartCount,
  Image,
  Island,
  accountLink,
  menuDrawer,
  openCart,
  stickyHeader,
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

/** Only this plugin's resolved, image-backed lead can support light overlay chrome. */
function supportsOverlay(data: HeaderProps<HeaderSettings>["data"]): boolean {
  const lead = data.page?.lead;
  // The store's hero drawn by Noor's hero skin: it renders only with a photo, and overlays unless split.
  if (lead?.kind === "core") return lead.type === "hero" && lead.skin?.id === "noor-hero" && lead.skin.settings.layout !== "split";
  if (lead?.kind !== "app" || lead.pluginId !== "scalius.noor" || !lead.settings) return false;
  const hasImage = (value: unknown): boolean => typeof value === "object" && value !== null
    && "url" in value && typeof value.url === "string" && value.url.length > 0;
  const images = (settings: unknown) => typeof settings === "object" && settings !== null
    && (("image" in settings && hasImage(settings.image)) || ("phone_image" in settings && hasImage(settings.phone_image)));
  return lead.type === "slideshow" && Array.isArray(lead.settings.slides)
    && lead.settings.slides.some(images);
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

/** A menu heading ("No link (heading only)") reaches the skin as "#": it names its links, it is not one. */
export function linked(item: StorefrontMenuItem): boolean {
  return item.url !== "" && item.url !== "#";
}

/** Where the page sits in the menu: an item's `aria-current` (the page itself, or the section it is in). */
export type MenuCurrent = (item: StorefrontMenuItem) => "page" | "true" | undefined;

const NO_CURRENT: MenuCurrent = () => undefined;

/** The same-store path a link points at, without a trailing slash; null for headings and other sites. */
function storePath(url: string, base: URL): string | null {
  const value = url.trim();
  if (!value || value.startsWith("#")) return null;
  try {
    const target = new URL(value, base);
    if (target.origin !== base.origin) return null;
    return target.pathname.length > 1 ? target.pathname.replace(/\/+$/, "") : target.pathname;
  } catch {
    return null;
  }
}

/** The page's place in the menu, by the store's rule (navigation-state.ts): the same path, query aside. */
export function menuCurrent(pagePath: string, storeUrl: string): MenuCurrent {
  let base: URL;
  try {
    base = new URL(storeUrl || "/", "https://store.invalid/");
  } catch {
    return NO_CURRENT;
  }
  const here = storePath(pagePath, base);
  if (here === null) return NO_CURRENT;
  const isPage = (item: StorefrontMenuItem) => linked(item) && storePath(item.url, base) === here;
  const inSection = (item: StorefrontMenuItem): boolean => item.children.some((child) => isPage(child) || inSection(child));
  return (item) => (isPage(item) ? "page" : inSection(item) ? "true" : undefined);
}

/** `aria-current` for a link that names its item's own page ("All X"): only the page itself. */
const pageOnly = (current: MenuCurrent, item: StorefrontMenuItem) => (current(item) === "page" ? "page" : undefined);

/** An item's link, or its name when it is a heading. */
function ItemLink({ item, class: className, current = NO_CURRENT }: { item: StorefrontMenuItem; class?: string; current?: MenuCurrent }) {
  return linked(item)
    ? <a class={className} href={item.url} aria-current={current(item)}>{item.title}</a>
    : <span class={cx(className, "noor-menu-heading")}>{item.title}</span>;
}

function Menu({ items, style, limit, context, current }: { items: StorefrontMenuItem[]; style: string; limit: number; context: Context; current: MenuCurrent }) {
  const extras = items.slice(limit);
  return (
    <ul class="noor-nav-list" data-nav-overflow>
      {items.slice(0, limit).map((item, index) => {
        const children = item.children;
        const deep = children.some((child) => child.children.length > 0);
        const panel = `noor-nav-panel-${index}`;
        const disclosure = children.length > 0
          ? { "data-disclosure": "popup", "aria-expanded": "false", "aria-controls": panel }
          : {};
        return (
          <li class={cx("noor-nav-item", children.length > 0 && "has-menu")} data-nav-index={String(index)}
            data-disclosure-item={children.length > 0 ? "" : undefined}>
            {linked(item) ? (
              <a class="noor-nav-link" href={item.url} title={item.title} data-nav-link aria-current={current(item)}><span>{item.title}</span></a>
            ) : (
              // A heading is the button that opens its links; it goes nowhere itself.
              <button type="button" class="noor-nav-link noor-nav-heading" title={item.title} data-nav-link {...disclosure}>
                <span>{item.title}</span>{children.length > 0 ? <Icon name="down" size={14} /> : null}
              </button>
            )}
            {children.length > 0 && linked(item) ? (
              <button type="button" class="noor-nav-toggle" {...disclosure}>
                <span class="noor-sr">{t(context, { en: `${item.title} menu`, bn: `${item.title} মেনু` })}</span>
                <Icon name="down" size={14} />
              </button>
            ) : null}
            {children.length > 0 ? (
              style === "mega" && deep ? (
                <div class="noor-mega" id={panel} hidden>
                  <div class="noor-mega-inner">
                    {children.map((child) => (
                      <div class="noor-mega-col">
                        <ItemLink item={child} class="noor-mega-head" current={current} />
                        {child.children.length > 0 ? <MenuLinks items={child.children} current={current} /> : null}
                      </div>
                    ))}
                    {linked(item) ? <a class="noor-mega-all" href={item.url} aria-current={pageOnly(current, item)}>{item.title}<Icon name="arrow" size={14} /></a> : null}
                  </div>
                </div>
              ) : (
                <div class="noor-drop" id={panel} hidden>
                  <MenuLinks items={children} current={current} />
                </div>
              )
            ) : null}
          </li>
        );
      })}
      {/* The roots past the row, with every level of their links, and any row
          item that does not fit (the store's script moves it in, as it is). */}
      <li class="noor-nav-item noor-nav-more-item" data-nav-more data-disclosure-item hidden={extras.length === 0}>
        <button type="button" class="noor-nav-link noor-nav-more" data-nav-link data-disclosure="popup" aria-expanded="false" aria-controls="noor-nav-more"
          aria-label={t(context, { en: "More menu items", bn: "আরও মেনু আইটেম" })}>
          <span>{t(context, { en: "More", bn: "আরও" })}</span><Icon name="down" size={14} />
        </button>
        <div class="noor-drop noor-more" id="noor-nav-more" hidden>
          <ul class="noor-more-list" data-nav-more-list>
            {extras.map((item) => (
              <li class="noor-more-extra">
                <ItemLink item={item} class="noor-more-root" current={current} />
                {item.children.length > 0 ? <MenuLinks items={item.children} current={current} /> : null}
              </li>
            ))}
          </ul>
        </div>
      </li>
    </ul>
  );
}

/** Keep every merchant menu level reachable, including compact desktop menus. */
export function MenuLinks({ items, current = NO_CURRENT }: { items: StorefrontMenuItem[]; current?: MenuCurrent }) {
  return <ul>{items.map((item) => <li>
    <ItemLink item={item} current={current} />
    {item.children.length > 0 ? <MenuLinks items={item.children} current={current} /> : null}
  </li>)}</ul>;
}

function DrawerMenu({ items, context, current, nested = false }: { items: StorefrontMenuItem[]; context: Context; current: MenuCurrent; nested?: boolean }) {
  return (
    <ul class={nested ? undefined : "noor-drawer-list"}>
      {items.map((item) => (
        <li>
          {item.children.length > 0 ? (
            <details>
              {/* One level at a time: an open level covers the one before, and its summary is the way back. */}
              <summary>
                <span class="noor-drawer-back" aria-hidden="true"><Icon name="back" size={16} /></span>
                <span>{item.title}</span>
                <Icon name="down" size={16} />
              </summary>
              {linked(item) ? <ul><li><a href={item.url} aria-current={pageOnly(current, item)}>{t(context, { en: `All ${item.title}`, bn: `সব ${item.title}` })}</a></li></ul> : null}
              <DrawerMenu items={item.children} context={context} current={current} nested />
            </details>
          ) : <ItemLink item={item} current={current} />}
        </li>
      ))}
    </ul>
  );
}

export function Header({ data, settings, context }: HeaderProps<HeaderSettings>) {
  const own = settings.announcements.flatMap((item) => (text(item.text) ? [{ text: text(item.text)!, link: text(item.link) }] : []));
  const announcements = own.length > 0 ? own : data.announcement ? [{ text: data.announcement.text, link: data.announcement.url }] : [];
  const campaign = context.page.kind === "landing" && choice(settings.landing_header, ["full", "campaign"] as const, "campaign") === "campaign";
  const transparent = settings.transparent_home && context.page.kind === "home" && supportsOverlay(data);
  const layout = choice(settings.layout, ["center", "start"] as const, "center");
  const logo = (
    <a class="noor-logo" href={data.routes.home} aria-label={data.store.name}>
      {data.store.logo ? <Image image={data.store.logo} alt={data.store.name} loading="eager" class="noor-logo-img" /> : <span class="noor-logo-text">{data.store.name}</span>}
    </a>
  );
  if (campaign) {
    return (
      <div class={cx("noor-header-shell", settings.sticky && "is-sticky")} {...(settings.sticky ? stickyHeader() : {})} style={{ "--noor-logo-width": `${data.store.logoWidth}px` }}>
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
  const current = menuCurrent(context.page.path, data.store.url);
  // Phones get one search: the header's button when it shows one (with or
  // without the store's tab bar, which never repeats Search), else the drawer's field.
  const drawerSearch = !settings.show_search;
  return (
    <div class={cx("noor-header-shell", settings.sticky && "is-sticky", transparent && "is-transparent")} {...(settings.sticky ? stickyHeader() : {})} style={{ "--noor-logo-width": `${data.store.logoWidth}px` }}>
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
            {/* Keep the desktop row bounded; More lists the rest. The drawer is the phone navigation. */}
            {data.menu.length > 0 ? (
              <nav class="noor-nav noor-desk-only" aria-label={t(context, { en: "Main", bn: "প্রধান" })}>
                <Menu items={data.menu} style={choice(settings.menu_style, ["mega", "simple"] as const, "mega")} limit={layout === "center" ? 6 : 4} context={context} current={current} />
              </nav>
            ) : null}
            <div class="noor-header-end">
              {settings.show_search ? (
                <button type="button" class={cx("noor-icon-btn", layout === "center" && "noor-phone-only")} popovertarget="noor-search" aria-label={searchLabel}>
                  <Icon name="search" size={21} />
                </button>
              ) : null}
              {settings.show_account ? (
                <a class="noor-icon-btn noor-desk-only" href={data.routes.account} {...accountLink()} aria-label={t(context, { en: "Account", bn: "অ্যাকাউন্ট" })}>
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
      <div id="noor-drawer" popover="auto" class={cx("noor-drawer", data.phoneNavigation?.menu === "drill" && "is-drill")}
        aria-label={t(context, { en: "Menu", bn: "মেনু" })} {...menuDrawer()}>
        <div class="noor-drawer-top">
          <span class="noor-drawer-title">{data.store.name}</span>
          <button type="button" class="noor-icon-btn" popovertarget="noor-drawer" popovertargetaction="hide" aria-label={t(context, { en: "Close menu", bn: "মেনু বন্ধ করুন" })}>
            <Icon name="close" size={22} />
          </button>
        </div>
        {drawerSearch ? (
          <form class="noor-field is-search" action={data.routes.search} method="get" role="search">
            <Icon name="search" size={18} />
            <input type="search" name={data.searchParam} placeholder={t(context, { en: "Search products", bn: "পণ্য খুঁজুন" })} aria-label={searchLabel} />
          </form>
        ) : null}
        <nav class="noor-drawer-nav" aria-label={t(context, { en: "Main", bn: "প্রধান" })}><DrawerMenu items={data.menu} context={context} current={current} /></nav>
        <div class="noor-drawer-foot">
          <a href={data.routes.account} {...accountLink()}><Icon name="user" size={18} />{t(context, { en: "My account", bn: "আমার অ্যাকাউন্ট" })}</a>
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
