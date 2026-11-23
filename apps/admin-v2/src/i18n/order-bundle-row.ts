import { defineMessages } from "./index";

/** A saved bundle's row on a staff order (loaded only when an order holds one). */
export const orderBundleRowMessages = defineMessages({
  en: {
    bundleItems: "{count, plural, one {Bundle of # item} other {Bundle of # items}}",
    showBundleItems: "Show items",
    hideBundleItems: "Hide items",
    bundleItemsOf: "Items in {name}",
  },
  bn: {
    bundleItems: "{count}টি আইটেমের বান্ডেল",
    showBundleItems: "আইটেমগুলো দেখুন",
    hideBundleItems: "আইটেমগুলো লুকান",
    bundleItemsOf: "{name}-এর আইটেম",
  },
});
