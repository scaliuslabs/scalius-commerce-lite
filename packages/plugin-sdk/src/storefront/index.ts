// @scalius/plugin-sdk/storefront: an app's storefront module. Components are
// JSX (or `html` templates) that build HTML on the server; islands are the
// only client code. Set `"jsxImportSource": "@scalius/plugin-sdk/storefront"`
// in the app's tsconfig (the scaffold does).
//
//   import { BuyForm, defineStorefront, Image, Price, quickAdd } from "@scalius/plugin-sdk/storefront";
//
//   export default defineStorefront({
//     sections: { hero: Hero },
//     components: { points: Points },
//     skins: { "clean-card": Card, "editorial-pdp": ProductMain },
//   });

export { defineStorefront, storefrontDefinitionOf } from "./define";
export type {
  AppComponent,
  ComponentProps,
  FooterComponent,
  FooterProps,
  HeaderComponent,
  HeaderProps,
  ListingMainComponent,
  ListingMainProps,
  ProductCardComponent,
  ProductCardProps,
  ProductMainComponent,
  ProductMainProps,
  SectionComponent,
  SectionProps,
  SectionSkinComponent,
  SectionSkinProps,
  SkinComponent,
  SkinProps,
  StorefrontDefinition,
  StorefrontModuleDefinition,
} from "./define";
export { EMPTY_HTML, escapeHtml, html, isHtml, raw, toHtml, type Html, type Renderable } from "./html";
export { Fragment, jsx, jsxs, type Component, type JSX } from "./jsx-runtime";
export {
  BuyForm, CartCount, Filters, Gallery, Image, Island, OrderForm, Pagination, Price, Recommendations, Reviews, Slot, Toolbar,
  accountLink, asset, editable, menuDrawer, openCart, quickAdd, searchOpener, stickyHeader,
} from "./components";
export { formatDate, formatMoney, formatNumber, plural, storeTime, t, type Words } from "./locale";
export type { BuyFormProps, ImageProps, IslandProps, OrderFormProps, PriceProps, SlotProps } from "./components";
export type {
  StorefrontBannerMosaicSkinSettings,
  StorefrontBannerSkinSettings,
  StorefrontComponentSlot,
  StorefrontComponentTarget,
  StorefrontBrandWallSkinSettings,
  StorefrontCategoryTilesSkinSettings,
  StorefrontCollectionsSkinSettings,
  StorefrontDealBlockSkinSettings,
  StorefrontDeliveryFacts,
  StorefrontEditorialSkinSettings,
  StorefrontFaqSkinSettings,
  StorefrontFocalPoint,
  StorefrontFooterData,
  StorefrontHeaderData,
  StorefrontHeroSkinSettings,
  StorefrontImage,
  StorefrontLink,
  StorefrontListingPage,
  StorefrontLookbookSkinSettings,
  StorefrontMenuItem,
  StorefrontMoney,
  StorefrontNewsletterSkinSettings,
  StorefrontObjectFieldView,
  StorefrontProductCard,
  StorefrontProductCardData,
  StorefrontProductGridSkinSettings,
  StorefrontProductList,
  StorefrontProductPage,
  StorefrontProductSlot,
  StorefrontProductRailSkinSettings,
  StorefrontProductTabsSkinSettings,
  StorefrontPromotionEnd,
  StorefrontRenderContext,
  StorefrontResolvedSettings,
  StorefrontSectionSkinData,
  StorefrontSectionSkinSettings,
  StorefrontSeoTextSkinSettings,
  StorefrontShopBySkinSettings,
  StorefrontSkinnableSection,
  StorefrontSkinTarget,
  StorefrontSpecificationsSkinSettings,
  StorefrontStoreInfo,
  StorefrontTile,
  StorefrontUspStripSkinSettings,
  StorefrontUtilityCardsSkinSettings,
} from "@scalius/shared/plugins/storefront-protocol";
