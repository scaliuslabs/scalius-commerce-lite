import { defineMessages } from "./index";

/** The merge of two saves (lib/merge-document.ts, MergeChoiceDialog.tsx). Apart from the presence copy, so each loads only with its screen. */
export const realtimeMergeMessages = defineMessages({
  en: {
    mergeTitle: "Choose which changes to keep",
    mergeBody: "Someone saved while you were editing. These fields were changed by both of you. Your other changes were combined with theirs.",
    mergeField: "Field",
    theirs: "Saved version",
    yours: "Your version",
    keepTheirs: "Keep saved",
    keepYours: "Keep mine",
    mergeSave: "Save",
    mergeCancel: "Cancel",
    emptyValue: "Empty",
    coupledHint: "Changed together with other fields",
    merged: "Changes combined",
    valueOn: "On",
    valueOff: "Off",
    valueItems: "{count, plural, one {# item} other {# items}}",
  },
  bn: {
    mergeTitle: "কোন পরিবর্তন রাখবেন বেছে নিন",
    mergeBody: "আপনি এডিট করার সময় অন্য কেউ সেভ করেছেন। এই ঘরগুলো দুজনেই বদলেছেন। আপনার বাকি পরিবর্তন তাদের সাথে মেলানো হয়েছে।",
    mergeField: "ঘর",
    theirs: "সেভ করা সংস্করণ",
    yours: "আপনার সংস্করণ",
    keepTheirs: "সেভ করাটি রাখুন",
    keepYours: "আমারটি রাখুন",
    mergeSave: "সেভ করুন",
    mergeCancel: "বাতিল",
    emptyValue: "খালি",
    coupledHint: "অন্য ঘরের সাথে একসাথে বদলেছে",
    merged: "পরিবর্তন মেলানো হয়েছে",
    valueOn: "চালু",
    valueOff: "বন্ধ",
    valueItems: "{count}টি আইটেম",
  },
});
