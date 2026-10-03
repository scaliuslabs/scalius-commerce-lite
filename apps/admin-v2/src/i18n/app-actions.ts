import { defineMessages } from "./index";

/**
 * Apps' manifest actions on list bulk bars. Apart from app-ui so list and
 * detail pages carry only these words until an app's dialog opens.
 */
export const appActionMessages = defineMessages({
  en: {
    appActions: "Apps",
    tooManySelected: "App actions run on up to {max} at a time.",
  },
  bn: {
    appActions: "অ্যাপ",
    tooManySelected: "অ্যাপের অ্যাকশন একবারে সর্বোচ্চ {max}টিতে চলে।",
  },
});
