import { expect, it } from "vitest";
import { localizedApp, translationFor } from "./app-text";

const translations = {
  bn: { name: "বিকাশ" },
  fr: { name: "Fidélité" },
  "pt-BR": { name: "Fidelidade BR" },
};

it("picks an app's text for the exact tag, then its language, else English", () => {
  expect(translationFor(translations, "bn")).toBe(translations.bn);
  expect(translationFor(translations, "pt-br")).toBe(translations["pt-BR"]);
  // A regional dashboard language falls back to the app's text for the language.
  expect(translationFor(translations, "fr-CA")).toBe(translations.fr);
  // No text for the language (or "pt" without a base entry): the manifest's English.
  expect(translationFor(translations, "pt")).toBeNull();
  expect(translationFor(translations, "de")).toBeNull();
  expect(translationFor(translations, "en")).toBeNull();
  expect(translationFor(undefined, "bn")).toBeNull();
  expect(translationFor(null as never, "bn")).toBeNull();
});

it("shows an app's name and description in the language it has text for", () => {
  const app = { name: "Loyalty", description: "Points", translations: { fr: { name: "Fidélité" } } } as Parameters<typeof localizedApp>[0];
  expect(localizedApp(app, "bn")).toBe(app);
  expect(localizedApp(app, "fr" as never)).toMatchObject({ name: "Fidélité", description: "Points" });
});
