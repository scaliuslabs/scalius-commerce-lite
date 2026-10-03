import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SOURCE_COMMIT,
  buildCountry,
  buildMetadata,
  parseCountryInfo,
  parseCppConstants,
  parseJavaConstants,
} from "./generate-address-metadata.mjs";

const JAVA = `
    map.put("AE",
        "{\\"name\\":\\"UNITED ARAB"
            + " EMIRATES\\",\\"fmt\\":\\"%N%n%O%n%A%n%S\\",\\"require\\":\\"AS\\",\\"state_name_type\\":\\"emirate\\"}");
    map.put("BD", "{\\"name\\":\\"BANGLADESH\\",\\"fmt\\":\\"%N%n%O%n%A%n%C - %Z\\"}");
    map.put("ZZ", "{\\"fmt\\":\\"%N%n%O%n%A%n%C\\",\\"require\\":\\"AC\\",\\"upper\\":\\"C\\"}");
`;
const CPP = `
  {"BD", "{"
      R"("fmt":"%N%n%O%n%A%n%C - %Z",)"
      R"("zipex":"1340,1000",)"
      R"("languages":"bn")"
      "}"},
`;
const INFO = [
  'data/BD={"id":"data/BD","key":"BD","zip":"\\\\d{4}","zipex":"1340,1000"}',
  'data/AE={"id":"data/AE","key":"AE","fmt":"%N%n%O%n%A%n%C","sub_keys":"Abu Dhabi~Dubai","sub_names":"Abu Dhabi~Dubai"}',
].join("\n");

describe("generate-address-metadata", () => {
  it("parses the three libaddressinput sources", () => {
    expect(parseJavaConstants(JAVA)).toMatchObject({ AE: { fmt: "%N%n%O%n%A%n%S", require: "AS" }, BD: { fmt: "%N%n%O%n%A%n%C - %Z" } });
    expect(parseCppConstants(CPP)).toEqual({ BD: { fmt: "%N%n%O%n%A%n%C - %Z", zipex: "1340,1000", languages: "bn" } });
    expect(parseCountryInfo(INFO).BD.zip).toBe("\\d{4}");
  });

  it("takes rules from the shipped constants and patterns only when consistent", () => {
    const { countries } = buildMetadata({ rules: parseJavaConstants(JAVA), examples: parseCppConstants(CPP), patterns: parseCountryInfo(INFO) });
    expect(Object.keys(countries)).toEqual(["AE", "BD"]);
    expect(countries.BD).toEqual({ fmt: "%N%n%O%n%A%n%C - %Z", zip: "\\d{4}", zipex: "1340,1000" });
    // The stale test copy says AE has a city; the shipped format has the emirate, so its areas are kept.
    expect(countries.AE).toEqual({
      fmt: "%N%n%O%n%A%n%S",
      require: "AS",
      state_name_type: "emirate",
      areas: [["Abu Dhabi", "Abu Dhabi"], ["Dubai", "Dubai"]],
    });
  });

  it("drops a postal pattern that refuses the shipped examples", () => {
    const built = buildCountry("XY", { fmt: "%A%n%Z" }, { zipex: "123456" }, { zip: "\\d{5}" });
    expect(built.record).toEqual({ fmt: "%A%n%Z", zipex: "123456" });
    expect(built.dropped).toHaveLength(1);
  });

  it("names the pinned source in the generated table", () => {
    const table = readFileSync(resolve(import.meta.dirname, "../packages/shared/src/address-metadata.data.ts"), "utf8");
    expect(table).toContain(SOURCE_COMMIT);
    expect(table).toContain("Apache License, Version 2.0");
  });
});
