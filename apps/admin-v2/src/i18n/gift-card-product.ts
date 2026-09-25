import { defineMessages } from "./index";

/**
 * The product editor's gift-card switch (the card title is `giftCardProduct`
 * in products.ts). Kept out of gift-cards.ts so the product form never
 * downloads the Gift cards pages' copy.
 */
export const giftCardProductMessages = defineMessages({
  en: {
    productSwitch: "This product is a gift card",
    productSwitchHelp: "Customers buy a code they spend at checkout.",
    productRuleDenominations: "Each variant is a denomination: its price is the card's value.",
    productRuleDelivery: "The code is sent by email or SMS after payment. Nothing ships.",
    productRuleNoTracking: "Quantity isn't tracked, and discounts and promotions don't apply.",
    productRuleNoGiftCardTender: "A gift card can't pay for another gift card.",
    productSwitchedOn: "Fulfilment is now digital, and the product discount is removed.",
  },
  bn: {
    productSwitch: "এই পণ্যটি একটি গিফট কার্ড",
    productSwitchHelp: "গ্রাহক একটি কোড কেনেন, যা চেকআউটে খরচ করা যায়।",
    productRuleDenominations: "প্রতিটি ভ্যারিয়েন্ট একটি মূল্যমান: এর দামই কার্ডের মূল্য।",
    productRuleDelivery: "পেমেন্টের পর কোডটি ইমেইল বা এসএমএসে যায়। কিছু শিপ হয় না।",
    productRuleNoTracking: "পরিমাণ ট্র্যাক হয় না, আর ডিসকাউন্ট ও প্রোমোশন খাটে না।",
    productRuleNoGiftCardTender: "গিফট কার্ড দিয়ে অন্য গিফট কার্ড কেনা যায় না।",
    productSwitchedOn: "ফুলফিলমেন্ট এখন ডিজিটাল, আর পণ্যের ডিসকাউন্ট সরানো হয়েছে।",
  },
});
