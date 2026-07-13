import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./GeneralSettingsPage.tsx", import.meta.url),
  "utf8",
);

describe("General settings render boundaries", () => {
  it("mounts the Auth & Access editor exactly once", () => {
    expect(source.match(/<AuthSettingsBuilder\s*\/>/g)).toHaveLength(1);
  });
});
