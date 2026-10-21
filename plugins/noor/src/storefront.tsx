// Noor's storefront module: the header, footer, product card and product page
// it gives the theme, its skins of the store's own sections, and the nine
// sections of its own, by the ids its manifest declares.

import { defineStorefront, type ProductCardProps } from "@scalius/plugin-sdk/storefront";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { ProductPage } from "./components/product";
import {
  CategoryTilesSkin,
  FaqSkin,
  HeroSkin,
  LookSkin,
  ProductGridSkin,
  ProductRailSkin,
  ProductTabsSkin,
  PromisesSkin,
  PromoTilesSkin,
  SaleSkin,
  ShopByTilesSkin,
  SignupSkin,
  SpecificationsSkin,
  StorySkin,
  TextSkin,
} from "./components/skins";
import { ProductCard } from "./components/ui";
import { FeaturedProduct } from "./components/sections/commerce";
import { Gallery, Marquee, Testimonials, VideoFeature } from "./components/sections/content";
import { Slideshow } from "./components/sections/hero";
import { LandingFeatures, LandingHero, LandingOrder } from "./components/sections/landing";

interface CardSettings {
  ratio: string;
  align: string;
  action: string;
  show_rating: boolean;
  show_hover: boolean;
}

function Card({ data, settings, context }: ProductCardProps<CardSettings>) {
  return (
    <ProductCard product={data.product} context={context} options={{
      ratio: settings.ratio,
      align: settings.align,
      action: settings.action,
      showRating: settings.show_rating,
      showHover: settings.show_hover,
      eager: data.aboveFold,
      slots: true,
    }} />
  );
}

export default defineStorefront({
  sections: {
    slideshow: Slideshow,
    marquee: Marquee,
    featured_product: FeaturedProduct,
    testimonials: Testimonials,
    video: VideoFeature,
    gallery: Gallery,
    landing_hero: LandingHero,
    landing_features: LandingFeatures,
    landing_order: LandingOrder,
  },
  skins: {
    noor_header: Header,
    noor_footer: Footer,
    noor_card: Card,
    noor_product: ProductPage,
    noor_hero: HeroSkin,
    noor_products_tabs: ProductTabsSkin,
    noor_products_grid: ProductGridSkin,
    noor_products_rail: ProductRailSkin,
    noor_tiles_categories: CategoryTilesSkin,
    noor_tiles_cards: ShopByTilesSkin,
    noor_promo_tiles: PromoTilesSkin,
    noor_look: LookSkin,
    noor_sale: SaleSkin,
    noor_promises: PromisesSkin,
    noor_story: StorySkin,
    noor_text: TextSkin,
    noor_faq: FaqSkin,
    noor_signup: SignupSkin,
    noor_specifications: SpecificationsSkin,
  },
});
