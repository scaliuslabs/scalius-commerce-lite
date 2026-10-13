// @scalius/plugin-sdk/storefront: an app's storefront module. Components are
// JSX (or `html` templates) that build HTML on the server; islands are the
// only client code. Set `"jsxImportSource": "@scalius/plugin-sdk/storefront"`
// in the app's tsconfig (the scaffold does).
//
//   import { defineStorefront, Image, Price, quickAdd } from "@scalius/plugin-sdk/storefront";
//
//   export default defineStorefront({
//     sections: { hero: Hero },
//     slots: { "clean-card": Card },
//   });

export { defineStorefront, storefrontDefinitionOf } from "./define";
export type {
  FooterComponent,
  FooterProps,
  HeaderComponent,
  HeaderProps,
  ProductCardComponent,
  ProductCardProps,
  SectionComponent,
  SectionProps,
  SlotProps,
  StorefrontDefinition,
  StorefrontModuleDefinition,
} from "./define";
export { EMPTY_HTML, escapeHtml, html, isHtml, raw, toHtml, type Html, type Renderable } from "./html";
export { Fragment, jsx, jsxs, type Component, type JSX } from "./jsx-runtime";
export { CartCount, Checkout, Image, Island, Price, accountLink, asset, editable, openCart, quickAdd, searchOpener, stickyHeader } from "./components";
export { formatDate, formatMoney, formatNumber, plural, storeTime, t, type Words } from "./locale";
export type { CheckoutProps, ImageProps, IslandProps, PriceProps } from "./components";
export type {
  StorefrontFooterData,
  StorefrontHeaderData,
  StorefrontImage,
  StorefrontMenuItem,
  StorefrontMoney,
  StorefrontProductCard,
  StorefrontRenderContext,
  StorefrontResolvedSettings,
  StorefrontStoreInfo,
} from "@scalius/shared/plugins/storefront-protocol";
