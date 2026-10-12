// Noor's storefront module: the header, footer and product card it gives
// the theme, and its sections, by the ids its manifest declares.

import { defineStorefront, type ProductCardProps } from "@scalius/plugin-sdk/storefront";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { ProductCard } from "./components/ui";
import { CollectionTiles, FeaturedProduct, ProductShowcase, PromoCountdown, PromoTiles, ShopTheLook } from "./components/sections/commerce";
import { Faq, Gallery, Marquee, Promises, RichText, SignupCall, Story, Testimonials, VideoFeature } from "./components/sections/content";
import { Hero, Slideshow } from "./components/sections/hero";
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
    hero: Hero,
    slideshow: Slideshow,
    marquee: Marquee,
    products: ProductShowcase,
    "featured-product": FeaturedProduct,
    "collection-tiles": CollectionTiles,
    "promo-tiles": PromoTiles,
    "shop-the-look": ShopTheLook,
    "sale-countdown": PromoCountdown,
    promises: Promises,
    "image-text": Story,
    "rich-text": RichText,
    testimonials: Testimonials,
    faq: Faq,
    video: VideoFeature,
    gallery: Gallery,
    signup: SignupCall,
    "landing-hero": LandingHero,
    "landing-features": LandingFeatures,
    "landing-order": LandingOrder,
  },
  slots: {
    "noor-header": Header,
    "noor-footer": Footer,
    "noor-card": Card,
  },
});
