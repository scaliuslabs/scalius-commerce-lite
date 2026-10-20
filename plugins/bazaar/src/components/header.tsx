// The Bazaar header: the marketplace's dark search-first bar (logo, an
// optional "Deliver to" chip, the search form with its department select,
// account, orders and cart) over the department row ("All" opens the
// left drawer; the menu's top items follow, each with a full-width panel
// when it has children). On phones the search drops to its own full-width
// row and the department row scrolls sideways.
//
// Menus use the store's disclosure pattern (buttons with aria-expanded and
// aria-controls; the store's nav-disclosure script adds click, Escape and
// hover intent). The drawer is a native popover marked `menuDrawer()`, so
// the store's phone tab bar opens it too. The department select needs the
// `search` island to send the query to that department's listing; without
// JavaScript the form searches the whole store.

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
import { cx, text, type Context } from "./ui";

export interface HeaderSettings {
  deliver_label: string | null;
  deliver_place: string | null;
  search_placeholder: string | null;
  account_greeting: string | null;
  promo_text: string | null;
  promo_link: string | null;
  sticky_phone: boolean;
  drawer_programs_title: string | null;
}

const linked = (item: StorefrontMenuItem) => item.url !== "" && item.url !== "#";

function ItemLink({ item, class: className }: { item: StorefrontMenuItem; class?: string }) {
  return linked(item) ? <a class={className} href={item.url}>{item.title}</a> : <span class={cx(className, "is-heading")}>{item.title}</span>;
}

/** The drawer's one-level-at-a-time list: a row with children opens its own panel with a back row. */
function DrawerList({ items, context, back }: { items: StorefrontMenuItem[]; context: Context; back?: string }) {
  return (
    <ul class="bz-drawer-list">
      {items.map((item) => (
        <li>
          {item.children.length > 0 ? (
            <details class="bz-drawer-sub">
              <summary><span>{item.title}</span><Icon name="chevron" size={18} /></summary>
              <div class="bz-drawer-panel">
                <p class="bz-drawer-back" aria-hidden="true"><Icon name="back" size={16} />{back ?? t(context, { en: "Main menu", bn: "প্রধান মেনু" })}</p>
                <p class="bz-drawer-heading">{item.title}</p>
                {linked(item) ? <a class="bz-drawer-all" href={item.url}>{t(context, { en: `See all ${item.title}`, bn: `সব ${item.title} দেখুন` })}</a> : null}
                <DrawerList items={item.children} context={context} back={item.title} />
              </div>
            </details>
          ) : <ItemLink item={item} />}
        </li>
      ))}
    </ul>
  );
}

function Departments({ items, context }: { items: StorefrontMenuItem[]; context: Context }) {
  return (
    <ul class="bz-subnav-list" data-nav-overflow>
      {items.map((item, index) => {
        const panel = `bazaar-nav-panel-${index}`;
        const hasPanel = item.children.length > 0;
        return (
          <li class="bz-subnav-item" data-nav-index={String(index)} data-disclosure-item={hasPanel ? "" : undefined}>
            {linked(item) ? <a class="bz-subnav-link" href={item.url} data-nav-link>{item.title}</a>
              : <span class="bz-subnav-link is-heading">{item.title}</span>}
            {hasPanel ? (
              <button type="button" class="bz-subnav-toggle" data-disclosure="popup" aria-expanded="false" aria-controls={panel}>
                <span class="bz-sr">{t(context, { en: `${item.title} departments`, bn: `${item.title} বিভাগ` })}</span>
                <Icon name="down" size={12} />
              </button>
            ) : null}
            {hasPanel ? (
              <div class="bz-mega" id={panel} hidden>
                <div class="bz-mega-inner">
                  {item.children.map((child) => (
                    <div class="bz-mega-col">
                      <ItemLink item={child} class="bz-mega-head" />
                      {child.children.length > 0 ? <ul>{child.children.map((leaf) => <li><ItemLink item={leaf} /></li>)}</ul> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function Header({ data, settings, context }: HeaderProps<HeaderSettings>) {
  const placeholder = text(settings.search_placeholder) ?? t(context, { en: `Search ${data.store.name}`, bn: `${data.store.name}-এ খুঁজুন` });
  const greeting = text(settings.account_greeting) ?? t(context, { en: "Hello, sign in", bn: "হ্যালো, সাইন ইন" });
  const deliver = text(settings.deliver_place);
  const promo = text(settings.promo_text);
  const departments = data.categories.length > 0 ? data.categories : data.menu;
  const searchLabel = t(context, { en: "Search", bn: "খুঁজুন" });
  return (
    <div class={cx("bz-header-shell", settings.sticky_phone && "is-sticky-phone")} {...(settings.sticky_phone ? stickyHeader() : {})}
      style={{ "--bz-logo-width": `${Math.min(data.store.logoWidth, 160)}px` }}>
      <header class="bz-header">
        <div class="bz-top">
          <button type="button" class="bz-top-btn bz-phone-only" popovertarget="bazaar-drawer" aria-label={t(context, { en: "Open the department menu", bn: "বিভাগের মেনু খুলুন" })}>
            <Icon name="menu" size={24} />
          </button>
          <a class="bz-logo bz-top-btn" href={data.routes.home} aria-label={data.store.name}>
            {data.store.logo
              ? <Image image={data.store.logo} alt={data.store.name} loading="eager" class="bz-logo-img" />
              : <span class="bz-logo-text">{data.store.name}<span class="bz-logo-smile" aria-hidden="true" /></span>}
          </a>
          {deliver ? (
            <a class="bz-top-btn bz-deliver bz-desk-only" href={data.routes.account} {...accountLink()}>
              <Icon name="pin" size={18} />
              <span class="bz-two-line">
                <span class="bz-line-1">{text(settings.deliver_label) ?? t(context, { en: "Deliver to", bn: "ডেলিভারি" })}</span>
                <span class="bz-line-2">{deliver}</span>
              </span>
            </a>
          ) : null}
          <Island name="search" hydrate="interaction" class="bz-search-island">
            <form class="bz-search" action={data.routes.search} method="get" role="search">
              {departments.length > 0 ? (
                <label class="bz-search-dept">
                  <span class="bz-sr">{t(context, { en: "Search in", bn: "যেখানে খুঁজবেন" })}</span>
                  {/* No name: the island sends the query to the chosen department's listing; without it the store is searched. */}
                  <select data-department>
                    <option value="">{t(context, { en: "All", bn: "সব" })}</option>
                    {departments.filter(linked).slice(0, 40).map((item) => <option value={item.url}>{item.title}</option>)}
                  </select>
                  <Icon name="down" size={12} />
                </label>
              ) : null}
              <input class="bz-search-input" type="search" name={data.searchParam} placeholder={placeholder} aria-label={placeholder} autocomplete="off" />
              <button type="submit" class="bz-search-go" aria-label={searchLabel}><Icon name="search" size={22} /></button>
            </form>
          </Island>
          <a class="bz-top-btn bz-account" href={data.routes.account} {...accountLink()}>
            <span class="bz-two-line">
              <span class="bz-line-1">{greeting}</span>
              <span class="bz-line-2">{t(context, { en: "Account & Lists", bn: "অ্যাকাউন্ট ও তালিকা" })}<Icon name="down" size={12} /></span>
            </span>
            <Icon name="user" size={24} class="bz-phone-only" />
          </a>
          <a class="bz-top-btn bz-orders bz-desk-only" href={data.routes.account}>
            <span class="bz-two-line">
              <span class="bz-line-1">{t(context, { en: "Returns", bn: "রিটার্ন" })}</span>
              <span class="bz-line-2">{t(context, { en: "& Orders", bn: "ও অর্ডার" })}</span>
            </span>
          </a>
          <a class="bz-top-btn bz-cart" href={data.routes.cart} {...openCart()} aria-label={t(context, { en: "Cart", bn: "কার্ট" })}>
            <span class="bz-cart-glyph"><Icon name="cart" size={34} /><CartCount class="bz-cart-count" /></span>
            <span class="bz-cart-word bz-desk-only" aria-hidden="true">{t(context, { en: "Cart", bn: "কার্ট" })}</span>
          </a>
        </div>
        <nav class="bz-subnav" aria-label={t(context, { en: "Departments", bn: "বিভাগ" })}>
          <button type="button" class="bz-all" popovertarget="bazaar-drawer">
            <Icon name="menu" size={20} /><span>{t(context, { en: "All", bn: "সব" })}</span>
          </button>
          {data.menu.length > 0 ? <Departments items={data.menu} context={context} /> : null}
          {promo ? (text(settings.promo_link) ? <a class="bz-subnav-promo bz-desk-only" href={text(settings.promo_link)!}>{promo}</a> : <span class="bz-subnav-promo bz-desk-only">{promo}</span>) : null}
        </nav>
        {data.announcement ? (
          <p class="bz-notice">{data.announcement.url ? <a href={data.announcement.url}>{data.announcement.text}</a> : data.announcement.text}</p>
        ) : null}
      </header>
      <div id="bazaar-drawer" popover="auto" class="bz-drawer" aria-label={t(context, { en: "All departments", bn: "সব বিভাগ" })} {...menuDrawer()}>
        <div class="bz-drawer-top">
          <a href={data.routes.account} {...accountLink()} class="bz-drawer-hello"><Icon name="user" size={26} /><span>{greeting}</span></a>
        </div>
        <div class="bz-drawer-body">
          {data.categories.length > 0 ? (
            <section class="bz-drawer-group">
              <h2>{t(context, { en: "Shop by Department", bn: "বিভাগ অনুযায়ী কেনাকাটা" })}</h2>
              <DrawerList items={data.categories} context={context} />
            </section>
          ) : null}
          {data.menu.length > 0 ? (
            <section class="bz-drawer-group">
              <h2>{text(settings.drawer_programs_title) ?? t(context, { en: "Programs & Features", bn: "প্রোগ্রাম ও ফিচার" })}</h2>
              <DrawerList items={data.menu} context={context} />
            </section>
          ) : null}
          <section class="bz-drawer-group">
            <h2>{t(context, { en: "Help & Settings", bn: "সাহায্য ও সেটিংস" })}</h2>
            <ul class="bz-drawer-list">
              <li><a href={data.routes.account} {...accountLink()}>{t(context, { en: "Your Account", bn: "আপনার অ্যাকাউন্ট" })}</a></li>
              <li><a href={data.routes.cart}>{t(context, { en: "Your Cart", bn: "আপনার কার্ট" })}</a></li>
            </ul>
          </section>
        </div>
        <button type="button" class="bz-drawer-close" popovertarget="bazaar-drawer" popovertargetaction="hide" aria-label={t(context, { en: "Close menu", bn: "মেনু বন্ধ করুন" })}>
          <Icon name="close" size={28} />
        </button>
      </div>
    </div>
  );
}
