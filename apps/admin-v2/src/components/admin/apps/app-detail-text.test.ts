import { expect, it } from "vitest";
import type { AppDetail } from "~/lib/api-query-options/apps";
import { localizedAppDetail } from "./app-detail-text";

it("translates setting choices without changing values, saved selections, defaults or English fallbacks", () => {
  const app = {
    name: "Example", description: "Example app", providers: [], features: [],
    admin: { pages: [], cards: [], actions: [], widgets: [] },
    settings: {
      fields: [
        { key: "environment", label: "Environment", help: "Choose a mode", type: "select", default: "sandbox", required: true, options: [{ value: "sandbox", label: "Sandbox" }, { value: "live", label: "Live" }] },
        { key: "channels", label: "Channels", type: "multiselect", options: [{ value: "email", label: "Email" }, { value: "constructor", label: "Custom channel" }] },
        { key: "key", label: "Private key", type: "secret", options: null },
      ],
      values: { environment: "retired", channels: ["email"] }, secrets: { key: true }, sections: [],
    },
    translations: { bn: { settings: {
      environment: { label: "পরিবেশ", options: { sandbox: "স্যান্ডবক্স" } },
      channels: { options: { email: "ইমেইল" } },
      key: { label: "প্রাইভেট কী" },
    } } },
  } as unknown as AppDetail;
  const localized = localizedAppDetail(app, "bn");
  expect(localized.settings.fields[0]).toMatchObject({
    label: "পরিবেশ", help: "Choose a mode", default: "sandbox", required: true,
    options: [{ value: "sandbox", label: "স্যান্ডবক্স" }, { value: "live", label: "Live" }],
  });
  expect(localized.settings.fields[1]?.options).toEqual([{ value: "email", label: "ইমেইল" }, { value: "constructor", label: "Custom channel" }]);
  expect(localized.settings.fields[2]).toMatchObject({ label: "প্রাইভেট কী", type: "secret", options: null });
  expect(localized.settings.values).toBe(app.settings.values);
  expect(localized.settings.secrets).toBe(app.settings.secrets);
  expect(localizedAppDetail(app, "en").settings).toBe(app.settings);
  expect(app.settings.fields[0]?.options?.[0]?.label).toBe("Sandbox");
});
