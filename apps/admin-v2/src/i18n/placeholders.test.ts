// Every dashboard string, formatted the way `t()` formats it, in both
// languages. A merchant once saw "{count, plural, one {# product} other {#
// products}}" on Sales channels and "Compare-at price ({symbol})" in a form
// error: a placeholder `t()` could not fill reached the screen as raw text.
// This test fails on any `{`, `}` or plural `#` left in an output, on a
// language that names a variable the English text does not (the caller passes
// the English variables only), and on a call that passes no variables to a
// string that needs them.
import { afterEach, describe, expect, it } from "vitest";
import { defineMessages, setLocale, translate, type Locale } from "./index";

type Catalog = { en: Record<string, string>; bn: Record<string, string> };

const modules = import.meta.glob<Record<string, unknown>>(["./*.ts", "!./*.test.ts"], { eager: true });

const catalogs: Array<[string, Catalog]> = Object.entries(modules)
  .filter(([file]) => !file.endsWith(".test.ts"))
  .flatMap(([file, exports]) => Object.entries(exports).flatMap(([name, value]): Array<[string, Catalog]> => {
    const catalog = value as Partial<Catalog> | null;
    return catalog && typeof catalog === "object" && catalog.en && catalog.bn && typeof catalog.bn === "object"
      ? [[`${file.slice(2)} › ${name}`, catalog as Catalog]]
      : [];
  }));

afterEach(() => setLocale("en"));

/** Names used as `{name}` or `{name, plural, …}`; the words inside a plural's choices are not names. */
function placeholders(template: string): { all: Set<string>; counted: Set<string> } {
  const counted = new Set(Array.from(template.matchAll(/\{(\w+), plural, /g), (match) => match[1]!));
  const all = new Set(counted);
  for (const match of template.matchAll(/\{(\w+)\}/g)) all.add(match[1]!);
  return { all, counted };
}

/** Sample values: a count where the string counts something, else a word. */
function sample(template: string, count: number): Record<string, string | number> {
  const { all, counted } = placeholders(template);
  return Object.fromEntries(Array.from(all, (name) => [name, counted.has(name) || /^(?:count|total|max|min|done|page|pages|rows|n)$/.test(name) ? count : "Sample"]));
}

const COUNTS = [0, 1, 2, 5, 1200];

function leftovers(text: string, template: string): string[] {
  const found = [];
  if (/[{}]/.test(text)) found.push("a raw { or }");
  if (template.includes(", plural,") && text.includes("#")) found.push("a raw #");
  return found;
}

/** Keys a screen shows or splits with the placeholder still in the text, on purpose. */
const SHOWN_WITH_PLACEHOLDER = new Set([
  // Help for the checkout text template: the merchant types these tokens.
  "termsTextHelp",
  "termsLinksMissing",
  "giftCardTextHelp",
  // Split at {name} or {names} to wrap the name in a link.
  "samePhoneAs",
  "phoneUsedBy",
  "mergedInto",
]);

describe("dashboard catalogs", () => {
  it("reads every catalog", () => {
    expect(catalogs.length).toBeGreaterThan(80);
  });

  it("formats every string in both languages with no placeholder left over", () => {
    const broken: string[] = [];
    let formatted = 0;
    for (const locale of ["en", "bn"] as Locale[]) {
      setLocale(locale);
      for (const [where, catalog] of catalogs) {
        const messages = defineMessages(catalog);
        for (const [key, template] of Object.entries(messages[locale])) {
          if (typeof template !== "string") continue;
          for (const count of COUNTS) {
            const output = translate(messages, key, sample(messages.en[key] ?? template, count));
            formatted += 1;
            for (const reason of leftovers(output, template)) broken.push(`${locale} ${where} › ${key} (${count}): ${reason}: ${output}`);
          }
        }
      }
    }
    expect(formatted).toBeGreaterThan(10_000);
    expect([...new Set(broken)]).toEqual([]);
  });

  it("names no variable in Bangla that the English text does not", () => {
    const extra = catalogs.flatMap(([where, catalog]) =>
      Object.entries(catalog.bn).flatMap(([key, template]) => {
        const english = placeholders(catalog.en[key] ?? "").all;
        const missing = [...placeholders(template).all].filter((name) => !english.has(name));
        return missing.length > 0 ? [`${where} › ${key}: ${missing.join(", ")}`] : [];
      }));
    expect(extra).toEqual([]);
  });

  it("gives every plural an other choice", () => {
    const missing = catalogs.flatMap(([where, catalog]) =>
      (["en", "bn"] as const).flatMap((locale) =>
        Object.entries(catalog[locale]).flatMap(([key, template]) =>
          template.includes(", plural,") && !/ other \{/.test(template) ? [`${locale} ${where} › ${key}`] : [])));
    expect(missing).toEqual([]);
  });

  it("is passed its variables wherever it needs them", () => {
    // `t("key")` and `translate(catalog, "key")` with no variables, for a key
    // whose every catalog text holds a placeholder.
    const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
    const needs = new Map<string, boolean>();
    for (const [, catalog] of catalogs) {
      for (const [key, template] of Object.entries(catalog.en)) {
        needs.set(key, (needs.get(key) ?? true) && placeholders(template).all.size > 0);
      }
    }
    const calls = Object.entries(sources)
      .filter(([file]) => !/\.test\.|\/i18n\//.test(file))
      .flatMap(([file, text]) =>
        Array.from(text.matchAll(/(?:\b[a-z]{1,3}\(|\btranslate\(\s*\w+\s*,)\s*"([^"]+)"\s*\)/g), (match) => ({ file, key: match[1]! }))
          .filter(({ key }) => needs.get(key) === true && !SHOWN_WITH_PLACEHOLDER.has(key)));
    expect(calls.map(({ file, key }) => `${file}: ${key}`)).toEqual([]);
  });
});
