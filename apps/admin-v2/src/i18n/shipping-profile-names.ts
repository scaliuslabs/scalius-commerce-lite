import { defineMessages } from "./index";

/**
 * The default shipping profile's name while it is still the one every store
 * starts with ("General", migration 0185): shown in the dashboard's language
 * until the merchant renames it. Small, so the product editor loads it.
 */
export const shippingProfileNameMessages = defineMessages({
  en: { defaultProfile: "General" },
  bn: { defaultProfile: "সাধারণ" },
});
