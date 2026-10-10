import { afterEach, expect, it } from "vitest";
import { setLocale } from "./index";
import { providerLabel, providerSetupReason } from "./provider-copy";

afterEach(() => setLocale("en"));

it("translates provider setup copy and field labels together", () => {
  setLocale("bn");
  expect(providerSetupReason("Activate Bangladesh pack in Apps to use it."))
    .toBe("এটি ব্যবহার করতে অ্যাপে গিয়ে বাংলাদেশ প্যাক চালু করুন।");
  expect(providerSetupReason("Complete bKash's settings: App key, App secret, Username, Password."))
    .toBe("bKash-এর সেটিংসে এই তথ্যগুলো দিন: অ্যাপের চাবি, অ্যাপের গোপন চাবি, ব্যবহারকারীর নাম, পাসওয়ার্ড।");
  expect(providerSetupReason("Complete Nagad (unverified)'s settings: Merchant ID, Merchant private key, Nagad public key."))
    .toBe("নগদ (যাচাই হয়নি)-এর সেটিংসে এই তথ্যগুলো দিন: ব্যবসায়ীর আইডি, ব্যবসায়ীর গোপন চাবি, নগদের পাবলিক চাবি।");
});

it("keeps English setup copy and unknown provider diagnostics intact", () => {
  const reason = "Complete bKash's settings: App key, App secret, Username, Password.";
  expect(providerSetupReason(reason)).toBe(reason);
  setLocale("bn");
  expect(providerSetupReason("A provider-specific error")).toBe("A provider-specific error");
  expect(providerLabel("Custom provider")).toBe("Custom provider");
});

it("names first-party jobs in plain words without changing their identifiers", () => {
  expect(providerLabel("pathao-places", "en")).toBe("Update Pathao delivery areas");
  expect(providerLabel("places-sync", "bn")).toBe("ডেলিভারি এলাকা হালনাগাদ");
  expect(providerLabel("FraudChecker (custom API)", "bn")).toBe("FraudChecker (নিজস্ব সংযোগ)");
});
