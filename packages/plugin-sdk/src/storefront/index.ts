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

export { componentFor, defineStorefront, storefrontDefinitionOf } from "./define";
export type {
  AppComponent,
  ComponentProps,
  ComponentPropsFor,
  FooterComponent,
  FooterProps,
  HeaderComponent,
  HeaderProps,
  LayoutSlotComponentProps,
  ListingMainComponent,
  ListingMainProps,
  PageComponentProps,
  ProductCardComponent,
  ProductCardProps,
  ProductCardSlotComponentProps,
  ProductMainComponent,
  ProductMainProps,
  ProductSlotComponentProps,
  SectionComponent,
  SectionProps,
  SectionSkinComponent,
  SectionSkinProps,
  SkinComponent,
  SkinProps,
  StorefrontComponentTargetName,
  StorefrontDefinition,
  StorefrontLayoutSlot,
  StorefrontModuleDefinition,
} from "./define";
export { EMPTY_HTML, escapeHtml, html, isHtml, raw, toHtml, type Html, type Renderable } from "./html";
export { Fragment, jsx, jsxs, type Component, type JSX } from "./jsx-runtime";
export {
  BuyForm, BuyFormPart, CartCount, Deferred, Filters, Gallery, Image, Island, OrderForm, Pagination, Price, ProductModule, Recommendations, Reviews, Slot, Toolbar,
  accountLink, asset, buyVariant, chooseVariant, colorSchemeToggle, editable, menuDrawer, openCart, quickAdd, searchOpener, stickyHeader, whenSignedIn, whenSignedOut,
} from "./components";
export { currencyDecimalPlaces, formatDate, formatMoney, formatNumber, plural, storeTime, t, type Words } from "./locale";
/** The product modules `<ProductModule name="…" />` can place: the theme's own module ids. */
export { STOREFRONT_PRODUCT_MODULE_EMBEDS } from "@scalius/shared/plugins/storefront-protocol";
/** The buy form's parts `<BuyFormPart name="…" />` can place apart from it. */
export { STOREFRONT_BUY_FORM_PARTS } from "@scalius/shared/plugins/storefront-protocol";
/** The option layouts the buy form draws (`optionsLayout`, the options part's `layout`). */
export { STOREFRONT_BUY_FORM_OPTION_LAYOUTS } from "@scalius/shared/plugins/storefront-protocol";
/** Who honours a warranty, and its duration units: lists that grow at their end. */
export { STOREFRONT_WARRANTY_DURATION_UNITS, STOREFRONT_WARRANTY_PROVIDERS } from "@scalius/shared/plugins/storefront-protocol";
/** The kinds of a card's typed facts (`card.cardFacts`). */
export { STOREFRONT_CARD_FACT_KINDS } from "@scalius/shared/plugins/storefront-protocol";
/** The budgets the packer, the upload and the storefront hold a render to (`islandPropsBytes`, `htmlBytes`, …). */
export { STOREFRONT_COMPONENT_LIMITS } from "@scalius/shared/plugins/storefront-protocol";
/** The most product suggestions one `context.searchSuggestions` call answers. */
export { STOREFRONT_SEARCH_SUGGESTIONS_MAX } from "@scalius/shared/plugins/storefront-protocol";
export type { BuyFormPartProps, BuyFormProps, DeferredProps, ImageProps, IslandProps, OrderFormProps, PriceProps, ProductModuleProps, SlotProps } from "./components";
export type {
  StorefrontBannerMosaicSkinSettings,
  StorefrontBannerSkinSettings,
  StorefrontComponentSlot,
  StorefrontComponentTarget,
  StorefrontBrandWallSkinSettings,
  StorefrontCategoryTilesSkinSettings,
  StorefrontCollectionsSkinSettings,
  StorefrontDealBlockSkinSettings,
  StorefrontDeferredHydration,
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
  StorefrontSearchSuggestion,
  StorefrontProductGridSkinSettings,
  StorefrontProductList,
  StorefrontProductModuleEmbed,
  StorefrontBuyFormPart,
  StorefrontBuyFormOptionLayout,
  StorefrontWarrantyDurationUnit,
  StorefrontWarrantyProvider,
  StorefrontCardFactKind,
  StorefrontWarranty,
  StorefrontProductError,
  StorefrontProductPage,
  StorefrontProductSlot,
  StorefrontProductState,
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
  StorefrontSpecification,
  StorefrontSpecificationsSkinSettings,
  StorefrontStoreInfo,
  StorefrontTile,
  StorefrontUspStripSkinSettings,
  StorefrontUtilityCardsSkinSettings,
} from "@scalius/shared/plugins/storefront-protocol";
// The buy form's refusal codes (`context.product.state().error`): only ever added to, at the end.
export { STOREFRONT_PRODUCT_ERRORS } from "@scalius/shared/plugins/storefront-protocol";
