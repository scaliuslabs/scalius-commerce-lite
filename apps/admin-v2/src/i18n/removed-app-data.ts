import { defineMessages } from "./index";

/**
 * Data from removed apps: what an app that is no longer installed left in
 * the store (its object types, custom fields, settings), shown wherever that
 * data appears (Apps, Objects, Settings → Custom data), with the Super
 * Admin's "Delete data" for one app's group.
 */
export const removedAppDataMessages = defineMessages({
  en: {
    fromRemovedApp: "From a removed app: {app}",
    title: "Data from removed apps",
    body: "These apps are no longer installed. Their data stays until you reinstall the app, which takes it back, or delete it.",
    objectTypes: "{count, plural, one {# object type} other {# object types}}",
    records: "{count, plural, one {# entry} other {# entries}}",
    customFields: "{count, plural, one {# custom field} other {# custom fields}}",
    keyValues: "{count, plural, one {# stored value} other {# stored values}}",
    customerRoles: "{count, plural, one {# customer role} other {# customer roles}}",
    jobs: "{count, plural, one {# background job} other {# background jobs}}",
    catalogItems: "{count, plural, one {# catalogue item it created} other {# catalogue items it created}}",
    settings: "its settings",
    deleteData: "Delete data",
    deleteTitle: "Delete data from “{app}”?",
    deleteBody: "Permanently deletes {what}, with its logs and files. Catalogue items it created stay in your catalogue; those in the trash are deleted unless the store must keep them. This can't be undone.",
    deleting: "Deleting…",
    deleted: "Data deleted",
    deletedKept: "Data deleted. {count, plural, one {# trashed item stays} other {# trashed items stay}} because the store must keep it.",
    deleteFailed: "Couldn't delete the data. Nothing changed. Try again.",
    changed: "This data changed since the page loaded, or the app was installed again. Check it and try again.",
    superAdminOnly: "Only a Super Admin can delete it.",
  },
  bn: {
    fromRemovedApp: "সরিয়ে ফেলা অ্যাপ থেকে: {app}",
    title: "সরিয়ে ফেলা অ্যাপের তথ্য",
    body: "এই অ্যাপগুলো আর ইনস্টল করা নেই। অ্যাপটি আবার ইনস্টল না করা পর্যন্ত, যা তথ্য ফিরিয়ে নেয়, বা আপনি ডিলিট না করা পর্যন্ত এদের তথ্য থেকে যায়।",
    objectTypes: "{count}টি অবজেক্ট টাইপ",
    records: "{count}টি এন্ট্রি",
    customFields: "{count}টি কাস্টম ফিল্ড",
    keyValues: "{count}টি সংরক্ষিত মান",
    customerRoles: "{count}টি গ্রাহক ভূমিকা",
    jobs: "{count}টি ব্যাকগ্রাউন্ড কাজ",
    catalogItems: "এর তৈরি {count}টি ক্যাটালগ আইটেম",
    settings: "এর সেটিংস",
    deleteData: "তথ্য ডিলিট করুন",
    deleteTitle: "“{app}”-এর তথ্য ডিলিট করবেন?",
    deleteBody: "{what}, এর লগ ও ফাইলসহ চিরতরে ডিলিট হবে। এর তৈরি ক্যাটালগ আইটেম আপনার ক্যাটালগে থেকে যাবে; ট্র্যাশে থাকাগুলো ডিলিট হবে, যদি না স্টোরকে সেগুলো রাখতে হয়। এটি ফেরানো যাবে না।",
    deleting: "ডিলিট হচ্ছে…",
    deleted: "তথ্য ডিলিট হয়েছে",
    deletedKept: "তথ্য ডিলিট হয়েছে। ট্র্যাশের {count}টি আইটেম থেকে গেছে, কারণ স্টোরকে সেগুলো রাখতে হবে।",
    deleteFailed: "তথ্য ডিলিট করা যায়নি। কিছু বদলায়নি। আবার চেষ্টা করুন।",
    changed: "পেজ লোড হওয়ার পর এই তথ্য বদলেছে, বা অ্যাপটি আবার ইনস্টল হয়েছে। দেখে নিয়ে আবার চেষ্টা করুন।",
    superAdminOnly: "শুধু একজন সুপার অ্যাডমিন এটি ডিলিট করতে পারেন।",
  },
});
