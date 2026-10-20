// The Bazaar demo content pack: sample products a merchant can import in one
// click (and remove in one click) to see the theme with a full catalogue.
// It is data only, kept apart from the theme code: the storefront module
// never imports it, and nothing here reaches a store unless the merchant
// imports it, when it becomes ordinary products the store owns.
//
// The words are original sample copy. Photos are optional: each product
// names a file, and the import fetches `<demo_image_base>/<file>` only when
// the merchant sets that address (their own photos or a licensed set);
// without it the products import without photos.

export interface DemoProduct {
  /** Stable key of the item in this pack (the import's idempotency key and its record id). */
  key: string;
  name: string;
  description: string;
  /** Major units of the store's currency. */
  price: number;
  /** A sale, as a percentage off the price. */
  discountPercentage?: number;
  image: string;
}

export const DEMO_PACK_VERSION = 1;

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  { key: "wireless-earbuds", name: "Demo wireless earbuds with charging case", description: "Sample product for the Bazaar demo. Thirty hours of listening with the case, sweat resistant, touch controls.", price: 2499, discountPercentage: 20, image: "earbuds.jpg" },
  { key: "smart-speaker", name: "Demo smart speaker, compact", description: "Sample product for the Bazaar demo. Room-filling sound in a palm-sized speaker with a fabric finish.", price: 3999, image: "speaker.jpg" },
  { key: "4k-monitor", name: "Demo 27-inch 4K monitor", description: "Sample product for the Bazaar demo. Sharp IPS panel, slim bezels, height-adjustable stand.", price: 32999, discountPercentage: 12, image: "monitor.jpg" },
  { key: "mechanical-keyboard", name: "Demo mechanical keyboard, tenkeyless", description: "Sample product for the Bazaar demo. Hot-swappable switches, white backlight, braided cable.", price: 6499, image: "keyboard.jpg" },
  { key: "stand-mixer", name: "Demo stand mixer, 5 litre", description: "Sample product for the Bazaar demo. Ten speeds, a steel bowl, whisk, beater and dough hook.", price: 18999, discountPercentage: 25, image: "mixer.jpg" },
  { key: "cast-iron-pan", name: "Demo cast iron skillet, 26 cm", description: "Sample product for the Bazaar demo. Pre-seasoned, oven safe, for every hob.", price: 2299, image: "skillet.jpg" },
  { key: "cotton-sheets", name: "Demo cotton bed sheet set, queen", description: "Sample product for the Bazaar demo. Breathable percale weave, deep pockets, four pieces.", price: 3499, discountPercentage: 15, image: "sheets.jpg" },
  { key: "running-shoes", name: "Demo running shoes, lightweight", description: "Sample product for the Bazaar demo. Cushioned sole, breathable mesh upper, reflective details.", price: 5999, image: "shoes.jpg" },
  { key: "backpack", name: "Demo travel backpack, 30 litre", description: "Sample product for the Bazaar demo. Laptop sleeve, water-resistant fabric, luggage strap.", price: 4299, discountPercentage: 10, image: "backpack.jpg" },
  { key: "novel", name: "Demo novel, paperback", description: "Sample product for the Bazaar demo. A placeholder book that shows how titles, prices and ratings line up.", price: 699, image: "book.jpg" },
  { key: "building-blocks", name: "Demo building blocks set, 500 pieces", description: "Sample product for the Bazaar demo. Classic bricks in twelve colours with an idea booklet.", price: 2799, discountPercentage: 30, image: "blocks.jpg" },
  { key: "yoga-mat", name: "Demo yoga mat, non-slip", description: "Sample product for the Bazaar demo. Six millimetre cushion, carrying strap included.", price: 1899, image: "yoga-mat.jpg" },
];
