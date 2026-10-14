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
    }} />
  );
}

export default defineStorefront({
  sections: {
    slideshow: Slideshow,
    marquee: Marquee,
    "featured-product": FeaturedProduct,
    testimonials: Testimonials,
    video: VideoFeature,
    gallery: Gallery,
    "landing-hero": LandingHero,
    "landing-features": LandingFeatures,
    "landing-order": LandingOrder,
  },
  skins: {
    "noor-header": Header,
    "noor-footer": Footer,
    "noor-card": Card,
    "noor-product": ProductPage,
    "noor-hero": HeroSkin,
    "noor-products-tabs": ProductTabsSkin,
    "noor-products-grid": ProductGridSkin,
    "noor-products-rail": ProductRailSkin,
    "noor-tiles-categories": CategoryTilesSkin,
    "noor-tiles-cards": ShopByTilesSkin,
    "noor-promo-tiles": PromoTilesSkin,
    "noor-look": LookSkin,
    "noor-sale": SaleSkin,
    "noor-promises": PromisesSkin,
    "noor-story": StorySkin,
    "noor-text": TextSkin,
    "noor-faq": FaqSkin,
    "noor-signup": SignupSkin,
  },
});
