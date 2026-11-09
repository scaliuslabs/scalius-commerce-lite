import { defineMessages } from "./index";

/**
 * Names the platform gives the records every store starts with (the default
 * shipping profile, the first inventory location), shown in the dashboard's
 * language until the merchant renames them (`seededName`). Small, so every
 * editor that lists them loads it.
 */
export const seededNameMessages = defineMessages({
  en: { shp_default: "General", shp_free_delivery: "Free delivery", loc_default: "Main location" },
  bn: { shp_default: "সাধারণ", shp_free_delivery: "ফ্রি ডেলিভারি", loc_default: "প্রধান লোকেশন" },
});
