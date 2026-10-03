import { defineMessages } from "./index";

/** An installed app's provider offered beside the built-in ones (SMS, email, courier fraud check). */
export const appProvidersMessages = defineMessages({
  en: {
    builtIn: "Built in",
    apps: "Apps",
    fromApp: "From the {app} app",
    keysInApp: "{name} comes from the {app} app. Its keys are kept, encrypted, in the app's settings.",
    ready: "Ready",
    notReady: "Not ready",
    testConnection: "Test connection",
    testFailed: "Couldn't test the connection. Try again.",
    openApp: "Open {app}",
  },
  bn: {
    builtIn: "বিল্ট-ইন",
    apps: "অ্যাপ",
    fromApp: "{app} অ্যাপ থেকে",
    keysInApp: "{name} আসে {app} অ্যাপ থেকে। এর কীগুলো এনক্রিপ্ট করে অ্যাপের সেটিংসে রাখা আছে।",
    ready: "প্রস্তুত",
    notReady: "প্রস্তুত নয়",
    testConnection: "কানেকশন পরীক্ষা করুন",
    testFailed: "কানেকশন পরীক্ষা করা যায়নি। আবার চেষ্টা করুন।",
    openApp: "{app} খুলুন",
  },
});
