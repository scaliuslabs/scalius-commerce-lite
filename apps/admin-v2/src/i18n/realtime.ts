import { defineMessages } from "./index";

/** Presence and live save notices (components/admin/realtime/PresenceView.tsx). */
export const realtimeMessages = defineMessages({
  en: {
    alsoEditing: "{names} {count, plural, one {is} other {are}} also editing",
    andOthers: "{name} and {count, plural, one {# other} other {# others}}",
    savedByOther: "{name} saved changes",
    savedByYou: "You saved this in another tab",
    savedHint: "Your edits are kept. When you save, changes to different fields are combined.",
    savedHintClean: "Load their changes to see the latest version.",
    loadLatest: "Load latest",
    dismiss: "Dismiss",
  },
  bn: {
    alsoEditing: "{names} এটিও এডিট করছেন",
    andOthers: "{name} এবং আরও {count} জন",
    savedByOther: "{name} পরিবর্তন সেভ করেছেন",
    savedByYou: "আপনি অন্য ট্যাবে এটি সেভ করেছেন",
    savedHint: "আপনার এডিট রাখা আছে। সেভ করলে আলাদা ঘরের পরিবর্তনগুলো একসাথে মেলানো হবে।",
    savedHintClean: "সর্বশেষ সংস্করণ দেখতে তাদের পরিবর্তন লোড করুন।",
    loadLatest: "সর্বশেষটি লোড করুন",
    dismiss: "বন্ধ করুন",
  },
});
