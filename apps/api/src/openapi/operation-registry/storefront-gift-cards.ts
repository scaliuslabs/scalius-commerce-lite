// Agent operation registry rows for the storefront gift-card routes (Wave B
// §4.3, §4.5). Every one carries a gift-card code in or out: codes are bearer
// value the buyer types into the hosted checkout, balance page or account, so
// they stay outside agent I/O.
import type { OperationRegistryEntry } from "./entry";

export const STOREFRONT_GIFT_CARD_OPERATIONS = {
  "storefront.checkout_gift_cards_apply.apply": {
    exposure: "excluded",
    risk: "read",
    sensitive: true,
    reason:
      "Accepts a raw gift-card code and returns a short-lived apply handle for the hosted checkout; codes are bearer value and stay outside agent I/O.",
  },
  "storefront.checkout_gift_cards_balance.balance": {
    exposure: "excluded",
    risk: "read",
    sensitive: true,
    reason: "Accepts a raw gift-card code on the hosted balance page; codes are bearer value and stay outside agent I/O.",
  },
  "storefront.customer_auth_gift_cards.get_gift_cards": {
    exposure: "excluded",
    principals: ["customer"],
    reason: "Customer-cookie list behind the hosted account's Gift cards tab.",
  },
  "storefront.customer_auth_gift_cards_reveal.reveal": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason: "Returns a gift-card code to its signed-in owner in the hosted account; codes stay outside agent I/O.",
  },
  "storefront.customer_auth_gift_cards_save.save": {
    exposure: "excluded",
    principals: ["customer"],
    sensitive: true,
    reason: "Links a gift card to the customer-cookie account by its raw code; the buyer types the code in the hosted account.",
  },
} satisfies Record<string, OperationRegistryEntry>;
