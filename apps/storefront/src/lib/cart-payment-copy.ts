// What the cart page says when no payment method can take the order, in
// English and Bangla, keyed by the page's language like cart-line-copy.ts.
// The buyer is on the cart already: the words say what to change here, never
// "return to your cart" (the checkout's own wording, for the payment step).
import { storefrontLanguage } from "./storefront-language";
import { pageLanguage } from "./store-time-zone";

export interface CartPaymentCopy {
  /** Cash on delivery is the store's only way to pay and does not serve the delivery country. */
  codCountry: (country: string) => string;
  /** No payment method can take the order, for another reason. */
  noPaymentMethods: string;
}

const EN: CartPaymentCopy = {
  codCountry: (country) => `Cash on delivery isn't available for ${country}. Choose another delivery address.`,
  noPaymentMethods: "No payment method can take this order. Change the items or the delivery address.",
};

const BN: CartPaymentCopy = {
  codCountry: (country) => `${country}-এ ক্যাশ অন ডেলিভারি নেই। অন্য ডেলিভারি ঠিকানা বেছে নিন।`,
  noPaymentMethods: "কোনো পেমেন্ট পদ্ধতিতে এই অর্ডারটি নেওয়া যাচ্ছে না। পণ্য বা ডেলিভারি ঠিকানা বদলান।",
};

export function cartPaymentCopy(language: string = pageLanguage()): CartPaymentCopy {
  return storefrontLanguage(language) === "bn" ? BN : EN;
}
