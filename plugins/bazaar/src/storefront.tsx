// Bazaar's storefront module: the header, footer, card, product page and
// listing it gives the theme, its skins of the store's own sections, and
// its own sections, by the ids its manifest declares. It never imports the
// demo content pack (src/demo): demo words and photos reach a store only as
// ordinary merchant content, through the demo_content feature.

import { defineStorefront, type ProductCardProps } from "@scalius/plugin-sdk/storefront";
import { Footer } from "./components/footer";
import { Header } from "./components/header";
import { ProductPage } from "./components/product";
import { CardRow, DealRow, DealsSkin, HeroSkin, ImageRow, ListingPage, ProductRowSkin, QuadTilesSkin } from "./components/sections";
import { ProductCard, text } from "./components/ui";

interface CardSettings {
  fast_label: string | null;
  show_rating: boolean;
  show_add: boolean;
  show_seller: boolean;
}

function Card({ data, settings, context }: ProductCardProps<CardSettings>) {
  return (
    <ProductCard product={data.product} context={context} options={{
      eager: data.aboveFold,
      showRating: settings.show_rating,
      showAdd: settings.show_add,
      showSeller: settings.show_seller,
      fastLabel: text(settings.fast_label),
    }} />
  );
}

export default defineStorefront({
  sections: {
    card_row: CardRow,
    deal_row: DealRow,
    image_row: ImageRow,
  },
  skins: {
    bazaar_header: Header,
    bazaar_footer: Footer,
    bazaar_card: Card,
    bazaar_product: ProductPage,
    bazaar_listing: ListingPage,
    bazaar_hero: HeroSkin,
    bazaar_product_row: ProductRowSkin,
    bazaar_deals: DealsSkin,
    bazaar_quad_tiles: QuadTilesSkin,
  },
});
