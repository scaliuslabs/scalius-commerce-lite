#!/usr/bin/env node
// Generates packages/shared/src/address-metadata.data.ts, the per-country
// address rules (docs/MARKETS-DESIGN.md D7), from Google libaddressinput.
//
//   pnpm generate:address-metadata                   fetch the pinned sources and write the table
//   pnpm generate:address-metadata --sources <dir>   read local copies of the three files instead
//
// Sources, all from github.com/google/libaddressinput at SOURCE_COMMIT
// (Apache-2.0; the generated file keeps Google's copyright notice and names
// the licence, as Apache-2.0 section 4 asks):
//
// - common/.../RegionDataConstants.java: the format line (`fmt`), required
//   and upper-case fields and label types, as the library ships them;
// - cpp/src/region_metadata_constants.cc: postal code examples (`zipex`);
// - testdata/countryinfo.txt: the postal code pattern (`zip`) and the
//   top-level subdivisions (`sub_keys`, names, ISO 3166-2 ids). This file is
//   the library's test copy of the served data and is older in places, so a
//   pattern is kept only when the country's format has a postal code and
//   every shipped example matches it, and subdivisions only when the format
//   has an admin area.
//
// Lower levels (cities, districts), Latin formats and postal URLs are not
// kept: forms and validation need country-level facts only.
//
// Updating: change SOURCE_COMMIT, run the script, review the diff. A changed
// required-field set also changes the per-country shipping-address trigger
// (packages/database/scripts/shipping-address-triggers.ts); its test fails
// until a new migration installs the regenerated trigger.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SOURCE_REPOSITORY = "https://github.com/google/libaddressinput";
export const SOURCE_COMMIT = "5ef3a927bdd6002bf25c5c09029347bebf57a57b";
export const SOURCE_FILES = Object.freeze({
  rules: "common/src/main/java/com/google/i18n/addressinput/common/RegionDataConstants.java",
  examples: "cpp/src/region_metadata_constants.cc",
  patterns: "testdata/countryinfo.txt",
});

const root = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(root, "packages/shared/src/address-metadata.data.ts");

/** libaddressinput's default record (data/ZZ): what a country without its own value uses. */
const DEFAULTS = Object.freeze({
  fmt: "%N%n%O%n%A%n%C",
  require: "AC",
  upper: "C",
  zip_name_type: "postal",
  state_name_type: "province",
  locality_name_type: "city",
  sublocality_name_type: "suburb",
});

const LABEL_TYPES = ["zip_name_type", "state_name_type", "locality_name_type", "sublocality_name_type"];

const titleCase = (value) => value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());

/** `map.put("XX", "..." + "...")` entries of RegionDataConstants.java. */
export function parseJavaConstants(text) {
  const out = {};
  for (const match of text.matchAll(/map\.put\(\s*"([A-Z]{2})",\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+)\);/g)) {
    const json = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => JSON.parse(`"${part[1]}"`)).join("");
    out[match[1]] = JSON.parse(json);
  }
  return out;
}

/** `{"XX", "{" R"(...)" ... "}"}` entries of region_metadata_constants.cc. */
export function parseCppConstants(text) {
  const out = {};
  for (const match of text.matchAll(/\{"([A-Z]{2})", "\{"\s*((?:R"\((?:[^)]|\)(?!"))*\)"\s*)*)"\}"\}/g)) {
    const body = [...match[2].matchAll(/R"\(((?:[^)]|\)(?!"))*)\)"/g)].map((part) => part[1]).join("");
    out[match[1]] = JSON.parse(`{${body}}`);
  }
  return out;
}

/** `data/XX={...}` lines of countryinfo.txt (country level only). */
export function parseCountryInfo(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const match = /^data\/([A-Z]{2})=(\{.*\})$/.exec(line.trim());
    if (match && match[1] !== "ZZ") out[match[1]] = JSON.parse(match[2]);
  }
  return out;
}

const areasOf = (record) => {
  const keys = record.sub_keys.split("~");
  const names = record.sub_names?.split("~");
  const latin = record.sub_lnames?.split("~");
  const iso = record.sub_isoids?.split("~");
  return keys.map((key, index) => {
    const lname = latin?.[index];
    const name = names?.[index] || (lname ? (lname === lname.toUpperCase() ? titleCase(lname) : lname) : "") || key;
    return iso?.[index] ? [key, name, iso[index]] : [key, name];
  });
};

/**
 * One country's compact record (only what differs from DEFAULTS), and the
 * facts the consistency rules dropped.
 */
export function buildCountry(code, rules, examples, patterns) {
  const out = {};
  const dropped = [];
  const fmt = rules.fmt ?? DEFAULTS.fmt;
  if (fmt !== DEFAULTS.fmt) out.fmt = fmt;
  if ((rules.require ?? DEFAULTS.require) !== DEFAULTS.require) out.require = rules.require ?? "";
  if ((rules.upper ?? DEFAULTS.upper) !== DEFAULTS.upper) out.upper = rules.upper ?? "";
  for (const key of LABEL_TYPES) {
    if (rules[key] && rules[key] !== DEFAULTS[key]) out[key] = rules[key];
  }
  const zipex = examples?.zipex;
  if (fmt.includes("%Z")) {
    if (patterns?.zip) {
      const pattern = new RegExp(`^(?:${patterns.zip})$`, "i");
      const failing = (zipex ?? "").split(",").filter((example) => example && !pattern.test(example));
      if (failing.length === 0) out.zip = patterns.zip;
      else dropped.push(`${code}: postal pattern ${patterns.zip} refuses ${failing.join(", ")}`);
    }
    if (zipex) out.zipex = zipex;
  }
  if (fmt.includes("%S") && patterns?.sub_keys) out.areas = areasOf(patterns);
  return { record: out, dropped };
}

export function buildMetadata({ rules, examples, patterns }) {
  const countries = {};
  const dropped = [];
  // ZZ is libaddressinput's default record (DEFAULTS), not a country.
  for (const code of Object.keys(rules).filter((code) => code !== "ZZ").sort()) {
    const built = buildCountry(code, rules[code], examples[code], patterns[code]);
    countries[code] = built.record;
    dropped.push(...built.dropped);
  }
  return { countries, dropped };
}

function render(countries) {
  const lines = Object.entries(countries).map(([code, record]) => `  ${code}: ${JSON.stringify(record)},`);
  return `// AUTOMATICALLY GENERATED by scripts/generate-address-metadata.mjs. Do not edit.
//
// Country address metadata from Google libaddressinput
// (${SOURCE_REPOSITORY} at ${SOURCE_COMMIT}: ${Object.values(SOURCE_FILES).join(", ")}).
// Copyright (C) Google Inc. Licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0); reduced to country-level facts.
//
// Server-side only: \`@scalius/shared/address-metadata\` reads it, and the API
// serves one country's rules at a time. Browser bundles never import it.

/** One country's facts; an absent key takes libaddressinput's default (\`ADDRESS_METADATA_DEFAULTS\`). */
export interface CountryAddressMetadata {
  /** Field order: %N name, %O organisation, %A street lines, %D dependent locality, %C locality, %S admin area, %Z postal code, %X sorting code, %n new line. */
  fmt?: string;
  /** Required fields, as fmt letters. */
  require?: string;
  /** Fields written in upper case on a label. */
  upper?: string;
  /** Postal code pattern (a whole-value match, case-insensitive). */
  zip?: string;
  /** Postal code examples, comma-separated. */
  zipex?: string;
  zip_name_type?: string;
  state_name_type?: string;
  locality_name_type?: string;
  sublocality_name_type?: string;
  /** Top-level subdivisions: [key, display name, ISO 3166-2 suffix when known]. */
  areas?: ReadonlyArray<readonly [string, string, string?]>;
}

export const ADDRESS_METADATA_SOURCE = ${JSON.stringify({ repository: SOURCE_REPOSITORY, commit: SOURCE_COMMIT, files: Object.values(SOURCE_FILES), licence: "Apache-2.0" })} as const;

export const ADDRESS_METADATA_DEFAULTS = ${JSON.stringify(DEFAULTS)} as const;

export const ADDRESS_METADATA: Readonly<Record<string, CountryAddressMetadata>> = {
${lines.join("\n")}
};
`;
}

async function readSource(directory, path) {
  if (directory) return readFileSync(join(directory, path.split("/").at(-1)), "utf8");
  const url = `https://raw.githubusercontent.com/google/libaddressinput/${SOURCE_COMMIT}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fetching ${url} failed: ${response.status}`);
  return response.text();
}

async function main(argv) {
  const sourcesIndex = argv.indexOf("--sources");
  const directory = sourcesIndex >= 0 ? argv[sourcesIndex + 1] : null;
  const { countries, dropped } = buildMetadata({
    rules: parseJavaConstants(await readSource(directory, SOURCE_FILES.rules)),
    examples: parseCppConstants(await readSource(directory, SOURCE_FILES.examples)),
    patterns: parseCountryInfo(await readSource(directory, SOURCE_FILES.patterns)),
  });
  if (Object.keys(countries).length < 240 || !countries.BD || !countries.US) {
    throw new Error("The sources do not look like libaddressinput's country metadata.");
  }
  writeFileSync(OUTPUT, render(countries));
  for (const line of dropped) console.log(`dropped ${line}`);
  console.log(`Wrote ${Object.keys(countries).length} countries to ${OUTPUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
