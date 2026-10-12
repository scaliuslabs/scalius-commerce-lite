// Noor's storefront module: the header, footer and product card it gives
// the theme, and its sections, by the ids its manifest declares.

import { defineStorefront, type ProductCardProps } from "@scalius/plugin-sdk/storefront";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { ProductCard } from "./components/ui";
import { PromoCountdown, ProductShowcase, ShopTheLook } from "./components/sections/commerce";
import { CategoryBento, Faq, Gallery, Marquee, Promises, SignupCall, Story, Testimonials, VideoFeature } from "./components/sections/content";
import { HeroEditorial, HeroSlideshow } from "./components/sections/hero";
import { OrderLanding } from "./components/sections/landing";

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
    "hero-editorial": HeroEditorial,
    "hero-slideshow": HeroSlideshow,
    marquee: Marquee,
    "product-showcase": ProductShowcase,
    "category-bento": CategoryBento,
    "shop-the-look": ShopTheLook,
    "promo-countdown": PromoCountdown,
    testimonials: Testimonials,
    promises: Promises,
    story: Story,
    faq: Faq,
    video: VideoFeature,
    gallery: Gallery,
    signup: SignupCall,
    "order-landing": OrderLanding,
  },
  slots: {
    "noor-header": Header,
    "noor-footer": Footer,
    "noor-card": Card,
  },
});
