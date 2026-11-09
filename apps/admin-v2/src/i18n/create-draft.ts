import { defineMessages } from "./index";

/** A create form's unsaved draft, kept on this device and offered back on return. */
export const createDraftMessages = defineMessages({
  en: {
    title: "Restore your unsaved draft?",
    body: "You started this on {when} and didn't save it.",
    restore: "Restore",
    discard: "Discard draft",
  },
  bn: {
    title: "সেভ না করা খসড়া ফিরিয়ে আনবেন?",
    body: "আপনি {when}-এ এটি শুরু করেছিলেন, সেভ করেননি।",
    restore: "ফিরিয়ে আনুন",
    discard: "খসড়া বাদ দিন",
  },
});
