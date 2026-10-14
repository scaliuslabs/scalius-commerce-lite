import { defineMessages } from "./index";

/**
 * An app's features (`manifest.features`): the parts a merchant turns on one
 * at a time, each with its own consent. The feature names and descriptions
 * come from the app's manifest (and its translations); these are the words
 * around them.
 */
export const appFeaturesMessages = defineMessages({
  en: {
    title: "Features",
    description: "Turn on only what your store uses. Each feature asks for its own access when you turn it on, and loses it when you turn it off.",
    group_payment: "Payments",
    group_courier: "Delivery",
    group_sms: "Text messages",
    group_fraud: "Fraud checks",
    group_other: "Other",
    recommended: "Recommended",
    on: "On",
    off: "Off",
    toggleLabel: "Turn {name} on or off",
    activateFirst: "Activate the app first. Then turn on the features you use.",
    superAdminTurnsOn: "Only a Super Admin can turn a feature on, because it approves new access. You can turn features off.",
    noExtraAccess: "This feature asks for no access beyond what the app already has.",

    enableTitle: "Turn on {name}?",
    enableIntro: "{app} asks for this access to run {name}. Nothing else changes.",
    enable: "Turn on",
    enabled: "{name} is on.",
    enableFailed: "{name} could not be turned on.",
    enableConsent: "{app}'s actions for {name} are recorded as yours.",
    setUpNext: "Next, enter its keys where it is set up.",

    disableTitle: "Turn off {name}?",
    disableBody: "{app} stops {name} at once and loses its access. Its saved keys stay, so you can turn it on again later.",
    disable: "Turn off",
    disabled: "{name} is off.",
    disableFailed: "{name} could not be turned off.",
    cancel: "Cancel",

    access_data: "Store data",
    access_services: "What it does",
    access_hosts: "Websites it connects to",
    access_events: "Events it receives",
    access_checkout: "Checkout",
    access_jobs: "Runs scheduled jobs",
    access_publicRoutes: "Answers requests from the internet (such as payment or delivery updates)",
    access_storefront: "Adds to your storefront",
    access_admin: "Adds pages or cards to your dashboard",

    permissionsTitle: "Access by feature",
    permissionsDescription: "Everything each feature could reach. A feature has this access only while it is on.",
  },
  bn: {
    title: "ফিচার",
    description: "আপনার দোকান যা ব্যবহার করে শুধু সেটুকু চালু করুন। প্রতিটি ফিচার চালু করার সময় নিজের অনুমতি চায়, আর বন্ধ করলে সেই অনুমতি হারায়।",
    group_payment: "পেমেন্ট",
    group_courier: "ডেলিভারি",
    group_sms: "টেক্সট মেসেজ",
    group_fraud: "ফ্রড চেক",
    group_other: "অন্যান্য",
    recommended: "প্রস্তাবিত",
    on: "চালু",
    off: "বন্ধ",
    toggleLabel: "{name} চালু বা বন্ধ করুন",
    activateFirst: "আগে অ্যাপটি চালু করুন। তারপর যে ফিচারগুলো ব্যবহার করেন সেগুলো চালু করুন।",
    superAdminTurnsOn: "শুধু একজন সুপার অ্যাডমিন ফিচার চালু করতে পারেন, কারণ এতে নতুন অনুমতি দেওয়া হয়। আপনি ফিচার বন্ধ করতে পারেন।",
    noExtraAccess: "অ্যাপের যে অনুমতি আছে তার বাইরে এই ফিচার আর কিছু চায় না।",

    enableTitle: "{name} চালু করবেন?",
    enableIntro: "{name} চালাতে {app} এই অনুমতি চায়। আর কিছু বদলায় না।",
    enable: "চালু করুন",
    enabled: "{name} চালু হয়েছে।",
    enableFailed: "{name} চালু করা যায়নি।",
    enableConsent: "{name}-এর জন্য {app} যা করবে তা আপনার নামে রেকর্ড হবে।",
    setUpNext: "এরপর যেখানে এটি সেট আপ হয় সেখানে এর কী দিন।",

    disableTitle: "{name} বন্ধ করবেন?",
    disableBody: "{app} সঙ্গে সঙ্গে {name} বন্ধ করে এবং এর অনুমতি হারায়। সংরক্ষিত কী থেকে যায়, তাই পরে আবার চালু করতে পারবেন।",
    disable: "বন্ধ করুন",
    disabled: "{name} বন্ধ হয়েছে।",
    disableFailed: "{name} বন্ধ করা যায়নি।",
    cancel: "বাতিল",

    access_data: "দোকানের তথ্য",
    access_services: "যা করে",
    access_hosts: "যে ওয়েবসাইটগুলোর সাথে যোগাযোগ করে",
    access_events: "যে ইভেন্টগুলো পায়",
    access_checkout: "চেকআউট",
    access_jobs: "নির্ধারিত সময়ে কাজ চালায়",
    access_publicRoutes: "ইন্টারনেট থেকে আসা অনুরোধের উত্তর দেয় (যেমন পেমেন্ট বা ডেলিভারির আপডেট)",
    access_storefront: "আপনার স্টোরফ্রন্টে যোগ করে",
    access_admin: "আপনার ড্যাশবোর্ডে পেজ বা কার্ড যোগ করে",

    permissionsTitle: "ফিচার অনুযায়ী অনুমতি",
    permissionsDescription: "প্রতিটি ফিচার যা যা ব্যবহার করতে পারে। ফিচারটি চালু থাকলেই শুধু এই অনুমতি থাকে।",
  },
});
