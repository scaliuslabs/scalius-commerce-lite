import { defineMessages } from "./index";

export const dynamicSourceMessages = defineMessages({
  en: {
    cardFields: "Product card fields", cardFieldsHelp: "Show up to three public custom fields on product cards.", cardAdd: "Add a field", removeField: "Remove {name}", remove: "Remove",
    connect: "Connect", connectSetting: "Connect {name}", connected: "Connected source",
    disconnect: "Disconnect", close: "Close sources", source: "Source", choose: "Choose a source",
    resource: "Page content", fields: "Custom fields", objects: "Objects", record: "Published record",
    chooseRecord: "Choose a record", previous: "Previous records", next: "Next records",
    fallback: "The value above is used when this source is empty or unavailable.",
    failed: "Couldn't load sources. Try again.", retry: "Try again", empty: "No compatible sources",
    limit: "This item already has 20 connected settings.",
    title: "Title", description: "Description", image: "Image", url: "Page link",
  },
  bn: {
    cardFields: "পণ্য কার্ডের ফিল্ড", cardFieldsHelp: "পণ্য কার্ডে সর্বোচ্চ তিনটি প্রকাশ্য কাস্টম ফিল্ড দেখান।", cardAdd: "ফিল্ড যোগ করুন", removeField: "{name} সরান", remove: "সরান",
    connect: "সংযুক্ত করুন", connectSetting: "{name} সংযুক্ত করুন", connected: "সংযুক্ত উৎস",
    disconnect: "সংযোগ সরান", close: "উৎস বন্ধ করুন", source: "উৎস", choose: "একটি উৎস বাছুন",
    resource: "পৃষ্ঠার বিষয়বস্তু", fields: "কাস্টম ফিল্ড", objects: "অবজেক্ট", record: "প্রকাশিত রেকর্ড",
    chooseRecord: "একটি রেকর্ড বাছুন", previous: "আগের রেকর্ড", next: "পরের রেকর্ড",
    fallback: "উৎস খালি বা অনুপলব্ধ হলে উপরের মানটি ব্যবহার করা হবে।",
    failed: "উৎস লোড করা যায়নি। আবার চেষ্টা করুন।", retry: "আবার চেষ্টা করুন", empty: "মানানসই উৎস নেই",
    limit: "এই আইটেমে ইতিমধ্যে ২০টি সেটিং সংযুক্ত আছে।",
    title: "শিরোনাম", description: "বিবরণ", image: "ছবি", url: "পৃষ্ঠার লিংক",
  },
});
