// How the buyer's private pages are presented: the cart page, the cart drawer,
// the checkout (with how its payment choices look), the receipt and the
// account. Each block is a few choices from closed lists, nothing else: no
// markup, no script, no style of an app's. Core draws every page from them,
// with the theme's tokens, and keeps what the buyer must see and do there
// (contact, delivery, payment actions, legal notices, totals, every native
// error and the typed extension slots) whatever is chosen: no choice removes
// or hides one. The defaults draw each page as it was before the blocks
// existed (the 13 → 14 upgrade step adds them).
import { z } from "zod";

/** Where the totals sit on a wide screen: beside the form, or above it in one column. Phones always show them first. */
export const STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS = ["side", "top"] as const;
export type StorefrontPrivateSummaryPlacement = (typeof STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS)[number];

/** The checkout's payment methods: one row each, or tiles in a grid with the chosen method's details under them. */
export const STOREFRONT_PAYMENT_CHOICE_STYLES = ["list", "tiles"] as const;
export type StorefrontPaymentChoiceStyle = (typeof STOREFRONT_PAYMENT_CHOICE_STYLES)[number];

/** The cart drawer's width on a wide screen (phones show a bottom sheet either way). */
export const STOREFRONT_CART_DRAWER_WIDTHS = ["standard", "wide"] as const;
export type StorefrontCartDrawerWidth = (typeof STOREFRONT_CART_DRAWER_WIDTHS)[number];

/** The drawer's "You might also like" row: optional merchandising, so a store may leave it out. */
export const STOREFRONT_CART_DRAWER_RECOMMENDATIONS = ["shown", "hidden"] as const;
export type StorefrontCartDrawerRecommendations = (typeof STOREFRONT_CART_DRAWER_RECOMMENDATIONS)[number];

/** The receipt's cards: one column, or the first card beside the others on a wide screen. */
export const STOREFRONT_RECEIPT_LAYOUTS = ["stacked", "split"] as const;
export type StorefrontReceiptLayout = (typeof STOREFRONT_RECEIPT_LAYOUTS)[number];

/** The receipt's cards. Each is mandatory (the order and its totals, where it goes, what was bought): only their order is a choice. */
export const STOREFRONT_RECEIPT_SECTIONS = ["order", "delivery", "items"] as const;
export type StorefrontReceiptSection = (typeof STOREFRONT_RECEIPT_SECTIONS)[number];

/** The account's pages: a tab strip over the page, or a list beside it on a wide screen (the strip on phones). */
export const STOREFRONT_ACCOUNT_NAVIGATION_STYLES = ["tabs", "sidebar"] as const;
export type StorefrontAccountNavigationStyle = (typeof STOREFRONT_ACCOUNT_NAVIGATION_STYLES)[number];

export const storefrontCartPageBlockSchema = z.object({
  summary: z.enum(STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS),
}).strict();

export const storefrontCartDrawerBlockSchema = z.object({
  width: z.enum(STOREFRONT_CART_DRAWER_WIDTHS),
  recommendations: z.enum(STOREFRONT_CART_DRAWER_RECOMMENDATIONS),
}).strict();

export const storefrontCheckoutBlockSchema = z.object({
  summary: z.enum(STOREFRONT_PRIVATE_SUMMARY_PLACEMENTS),
  paymentChoices: z.enum(STOREFRONT_PAYMENT_CHOICE_STYLES),
}).strict();

export const storefrontReceiptBlockSchema = z.object({
  layout: z.enum(STOREFRONT_RECEIPT_LAYOUTS),
  /** Every card once, in the order the page shows them. */
  sections: z.array(z.enum(STOREFRONT_RECEIPT_SECTIONS))
    .length(STOREFRONT_RECEIPT_SECTIONS.length, "The receipt shows the order, delivery and items cards, each once.")
    .refine((sections) => new Set(sections).size === sections.length, "The receipt shows the order, delivery and items cards, each once."),
}).strict();

export const storefrontAccountBlockSchema = z.object({
  navigation: z.enum(STOREFRONT_ACCOUNT_NAVIGATION_STYLES),
}).strict();

export type StorefrontCartPageBlock = z.infer<typeof storefrontCartPageBlockSchema>;
export type StorefrontCartDrawerBlock = z.infer<typeof storefrontCartDrawerBlockSchema>;
export type StorefrontCheckoutBlock = z.infer<typeof storefrontCheckoutBlockSchema>;
export type StorefrontReceiptBlock = z.infer<typeof storefrontReceiptBlockSchema>;
export type StorefrontAccountBlock = z.infer<typeof storefrontAccountBlockSchema>;

/** The private pages' blocks, by their key in `blocks`. */
export const STOREFRONT_PRIVATE_PAGE_BLOCKS = ["cart", "cartDrawer", "checkout", "receipt", "account"] as const;
export type StorefrontPrivatePageBlock = (typeof STOREFRONT_PRIVATE_PAGE_BLOCKS)[number];

export interface StorefrontPrivatePageBlocks {
  cart: StorefrontCartPageBlock;
  cartDrawer: StorefrontCartDrawerBlock;
  checkout: StorefrontCheckoutBlock;
  receipt: StorefrontReceiptBlock;
  account: StorefrontAccountBlock;
}

/** Each page as it was drawn before these blocks: what an upgraded theme and every built-in template carry. */
export const STOREFRONT_PRIVATE_PAGE_DEFAULTS: Readonly<StorefrontPrivatePageBlocks> = Object.freeze({
  cart: Object.freeze({ summary: "side" }),
  cartDrawer: Object.freeze({ width: "standard", recommendations: "shown" }),
  checkout: Object.freeze({ summary: "side", paymentChoices: "list" }),
  receipt: Object.freeze({ layout: "stacked", sections: Object.freeze(["order", "delivery", "items"]) as unknown as StorefrontReceiptSection[] }),
  account: Object.freeze({ navigation: "tabs" }),
}) as Readonly<StorefrontPrivatePageBlocks>;

/** A fresh, mutable copy of the defaults. */
export function storefrontPrivatePageDefaults(): StorefrontPrivatePageBlocks {
  return structuredClone(STOREFRONT_PRIVATE_PAGE_DEFAULTS) as StorefrontPrivatePageBlocks;
}
