import { defineMessages, getLocale, translate } from "./index";

/** Dashboard labels supplied by the first-party provider APIs, never store data. */
export const providerCopyMessages = defineMessages({
  en: {
    bangladeshPack: "Bangladesh pack",
    nagadUnverified: "Nagad (unverified)",
    fraudCheckerCustom: "FraudChecker (custom API)",
    ecourierFraud: "eCourier Fraud Alert",
    pathaoPlaces: "Update Pathao delivery areas",
    placesSync: "Update delivery areas",
    activate: "Activate {app} in Apps to use it.",
    completeSettings: "Complete {name}'s settings: {fields}.",
    merchantId: "Merchant ID",
    merchantPrivateKey: "Merchant private key",
    nagadPublicKey: "Nagad public key",
    appKey: "App key",
    appSecret: "App secret",
    username: "Username",
    password: "Password",
  },
  bn: {
    bangladeshPack: "বাংলাদেশ প্যাক",
    nagadUnverified: "নগদ (যাচাই হয়নি)",
    fraudCheckerCustom: "FraudChecker (নিজস্ব সংযোগ)",
    ecourierFraud: "eCourier প্রতারণার সতর্কতা",
    pathaoPlaces: "পাঠাওয়ের ডেলিভারি এলাকা হালনাগাদ",
    placesSync: "ডেলিভারি এলাকা হালনাগাদ",
    activate: "এটি ব্যবহার করতে অ্যাপে গিয়ে {app} চালু করুন।",
    completeSettings: "{name}-এর সেটিংসে এই তথ্যগুলো দিন: {fields}।",
    merchantId: "ব্যবসায়ীর আইডি",
    merchantPrivateKey: "ব্যবসায়ীর গোপন চাবি",
    nagadPublicKey: "নগদের পাবলিক চাবি",
    appKey: "অ্যাপের চাবি",
    appSecret: "অ্যাপের গোপন চাবি",
    username: "ব্যবহারকারীর নাম",
    password: "পাসওয়ার্ড",
  },
});

const LABELS: Readonly<Record<string, keyof typeof providerCopyMessages.en>> = {
  "Bangladesh pack": "bangladeshPack",
  "Nagad (unverified)": "nagadUnverified",
  "FraudChecker (custom API)": "fraudCheckerCustom",
  "eCourier Fraud Alert": "ecourierFraud",
  "pathao-places": "pathaoPlaces",
  "places-sync": "placesSync",
  "Merchant ID": "merchantId",
  "Merchant private key": "merchantPrivateKey",
  "Nagad public key": "nagadPublicKey",
  "App key": "appKey",
  "App secret": "appSecret",
  Username: "username",
  Password: "password",
};

export function providerLabel(value: string, locale = getLocale()): string {
  const key = LABELS[value];
  return key ? providerCopyMessages[locale][key] : value;
}

/** The API currently supplies prose for these two setup states, without a reason code. */
export function providerSetupReason(reason: string): string {
  const activation = /^Activate (.+) in Apps to use it\.$/.exec(reason);
  if (activation) return translate(providerCopyMessages, "activate", { app: providerLabel(activation[1]!) });
  const setup = /^Complete (.+)'s settings: (.+)\.$/.exec(reason);
  if (setup) return translate(providerCopyMessages, "completeSettings", {
    name: providerLabel(setup[1]!),
    fields: setup[2]!.split(", ").map((field) => providerLabel(field)).join(", "),
  });
  return reason;
}
