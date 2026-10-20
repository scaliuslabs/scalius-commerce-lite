// Volt's storefront module: the header, footer, product card, product page
// and listing it gives the theme, its skins of the store's own sections and
// its three sections, by the ids its manifest declares. It holds no demo
// content: the demo store is data the demo feature imports (demo-pack/).

import { defineStorefront, type ProductCardProps } from "@scalius/plugin-sdk/storefront";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { Listing } from "./components/listing";
import { ProductPage } from "./components/product";
import { OfferCards, PromoBanner, TrustSection } from "./components/sections";
import {
  BannerMosaicSkin,
  BrandWallSkin,
  CategoryTilesSkin,
  DealSkin,
  HeroSkin,
  ProductGridSkin,
  ProductRailSkin,
  ProductTabsSkin,
  SeoTextSkin,
  UspSkin,
} from "./components/skins";
import { ProductCard } from "./components/ui";

function Card({ data, settings, context }: ProductCardProps<{ button: string }>) {
  const button = settings.button === "shop" ? "shop" : settings.button === "cart" ? "cart" : "none";
  return <ProductCard product={data.product} context={context} options={{ button, eager: data.aboveFold }} />;
}

export default defineStorefront({
  sections: {
    trust_strip: TrustSection,
    offer_cards: OfferCards,
    promo_banner: PromoBanner,
  },
  skins: {
    volt_header: Header,
    volt_footer: Footer,
    volt_card: Card,
    volt_product: ProductPage,
    volt_listing: Listing,
    volt_hero: HeroSkin,
    volt_usp: UspSkin,
    volt_categories: CategoryTilesSkin,
    volt_tabs: ProductTabsSkin,
    volt_grid: ProductGridSkin,
    volt_rail: ProductRailSkin,
    volt_deals: DealSkin,
    volt_brands: BrandWallSkin,
    volt_banners: BannerMosaicSkin,
    volt_about: SeoTextSkin,
  },
});
