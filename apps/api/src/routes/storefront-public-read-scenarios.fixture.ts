export const storefrontPublicReadScenarios = {
  loadBuyerShell: [
    "storefront.layout.get",
    "storefront.homepage.get",
    "storefront.seo.get",
  ],
  discoverCatalog: [
    "storefront.products.list",
    "storefront.search.predict",
    "storefront.categories.list",
    "storefront.categories.get_section",
    "storefront.categories.list_products",
    "storefront.collections.list",
    "storefront.collections.get",
  ],
  reconstructProduct: [
    "storefront.products.get_section",
  ],
  discoverFilters: [
    "storefront.attributes.list_filterable",
    "storefront.attributes.list_for_category",
    "storefront.attributes.list_for_search",
  ],
  prepareCheckout: [
    "storefront.checkout.get_config",
    "storefront.checkout_language.get_active",
    "storefront.locations.cities",
    "storefront.locations.zones",
    "storefront.locations.areas",
    "storefront.shipping_methods.list",
  ],
} as const;

/**
 * Browser compatibility reads with one canonical agent replacement. These
 * routes stay documented but must not become a second execution authority.
 */
export const storefrontPublicReadExcludedOperations = {
  unboundedCategoryAggregate: "storefront.categories.get",
  unboundedProductAggregate: "storefront.products.get",
  legacyVariantSearch: "storefront.products.search_legacy",
  categoryIdAttributeAlias: "storefront.attributes.category_id_alias",
  headerLayoutAlias: "storefront.layout.header_alias",
  footerLayoutAlias: "storefront.layout.footer_alias",
  pageRenderAlias: "storefront.pages.render_by_slug_alias",
} as const;

export const storefrontPublicPresentationOnlyScenarios = [
  "Following a merchant-configured external navigation or hero destination is open-world browser activity, not a storefront backend operation.",
  "Rendering analytics snippets is browser presentation; agents can read the public layout but cannot execute merchant scripts through operations.execute.",
] as const;
