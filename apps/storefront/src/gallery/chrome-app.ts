// A gallery-only theme app (dev and test, never bundled into a build): a
// header and a footer skin as a theme writes them for the buyer's own pages
// (`buyerPages: true`), using every store behaviour the inert rebuild keeps
// (sticky header, account link, signed-in and guest versions, cart count and
// opener, light or dark switch, menu drawer) and what it must drop (an
// island, a search form, a newsletter form, a fixed layer over the page).
// test-support/buyer-chrome.browser.mjs draws the account with it. Written
// with the SDK's JSX runtime directly: the storefront has no JSX for app modules.
import {
  CartCount, Island, Slot, accountLink, colorSchemeToggle, defineStorefront, menuDrawer, openCart, searchForm, stickyHeader, whenSignedIn, whenSignedOut,
  type FooterProps, type HeaderProps,
} from "../../../../packages/plugin-sdk/src/storefront/index";
import { jsx, type Renderable } from "../../../../packages/plugin-sdk/src/storefront/jsx-runtime";

/** The SDK's components take their own props; `jsx` takes any. */
const component = (part: unknown) => part as (props: Record<string, unknown>) => Renderable;

function Header({ data }: HeaderProps) {
  return jsx("div", {
    class: "gc-shell",
    ...stickyHeader(),
    children: jsx(component(Island), {
      name: "menu",
      hydrate: "load",
      children: [
        jsx("header", {
          class: "gc-header",
          children: [
            jsx("a", { class: "gc-logo", href: data.routes.home, style: { "--gc-logo-width": "120px" }, children: data.store.name }),
            jsx("form", {
              class: "gc-search",
              ...searchForm(data),
              children: [jsx("input", { type: "search", name: data.searchParam, "aria-label": "Search" }), jsx("button", { type: "submit", children: "Search" })],
            }),
            jsx("a", { class: "gc-cart", href: data.routes.cart, ...openCart(), "aria-label": "Cart", children: ["Cart ", jsx(component(CartCount), { class: "gc-count" })] }),
            jsx("a", { class: "gc-sign-in", href: data.routes.account, ...accountLink(), ...whenSignedOut(), children: "Sign in" }),
            jsx("a", { class: "gc-account", href: data.routes.account, ...whenSignedIn(), children: "My account" }),
            jsx("button", { class: "gc-scheme", type: "button", ...colorSchemeToggle(), "aria-pressed": "false", "aria-label": "Dark colours", children: "Scheme" }),
            jsx("button", { class: "gc-menu-button", type: "button", popovertarget: "chrome-drawer", "aria-controls": "chrome-drawer", children: "Menu" }),
            jsx("button", { class: "gc-signout", type: "button", children: "Sign out" }),
            jsx(component(Slot), { name: "header.actions" }),
          ],
        }),
        jsx("div", { class: "gc-cover", children: "Your account is locked: call 01700000000" }),
        jsx("div", {
          id: "chrome-drawer",
          class: "gc-drawer",
          popover: "auto",
          role: "dialog",
          "aria-label": "Menu",
          ...menuDrawer(),
          children: jsx("nav", { children: data.menu.slice(0, 6).map((item) => jsx("a", { class: "gc-drawer-link", href: item.url, children: item.title })) }),
        }),
      ],
    }),
  });
}

function Footer({ data }: FooterProps) {
  return jsx("footer", {
    class: "gc-footer",
    children: [
      jsx("p", { class: "gc-footer-name", children: data.store.name }),
      jsx("form", { class: "gc-newsletter", method: "post", action: "/apps/gallery.chrome/subscribe", children: [jsx("input", { type: "email", name: "email", "aria-label": "Email" }), jsx("button", { type: "submit", children: "Join" })] }),
      jsx("ul", { class: "gc-policies", children: data.policies.map((policy) => jsx("li", { children: jsx("a", { href: policy.url, children: policy.title }) })) }),
      jsx("a", { class: "gc-top", href: "#", children: "Back to top" }),
      jsx(component(Slot), { name: "footer.columns" }),
    ],
  });
}

export default defineStorefront({ skins: { gallery_header: Header, gallery_footer: Footer } });
