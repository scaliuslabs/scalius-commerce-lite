import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const cwd = new URL(".", import.meta.url).pathname;
const eslint = new ESLint({ cwd });

describe("dashboard select policy", () => {
  it.each([
    ['import { NativeSelect as Picker } from "~/components/ui/native-select"; export const x = Picker;', "no-restricted-imports"],
    ['import Picker from "./native-select.tsx"; export const x = Picker;', "no-restricted-imports"],
    ['import * as Picker from "@radix-ui/react-select"; export const x = Picker;', "no-restricted-imports"],
    ['import Picker from "~/components/ui/select"; export const x = Picker;', "no-restricted-imports"],
    ['export const x = <select />;', "no-restricted-syntax"],
    ['export const NativeSelect = () => null;', "no-restricted-syntax"],
  ])("rejects legacy selector: %s", async (source, ruleId) => {
    const [result] = await eslint.lintText(source, { filePath: "src/select-policy-probe.tsx" });
    expect(result?.messages.some((message) => message.ruleId === ruleId && message.severity === 2)).toBe(true);
  });

  it("allows SearchableSelect", async () => {
    const [result] = await eslint.lintText('import { SearchableSelect } from "~/components/ui/searchable-select"; export const x = <SearchableSelect options={[]} onValueChange={() => {}} />;', { filePath: "src/select-policy-probe.tsx" });
    expect(result?.messages.filter((message) => message.ruleId?.startsWith("no-restricted"))).toEqual([]);
  });
});
