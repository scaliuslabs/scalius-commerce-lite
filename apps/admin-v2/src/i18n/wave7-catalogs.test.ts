// The Wave 7 catalogs (app provider kinds, browser notifications, the exchange
// rate source, Web Push on this device) are complete in English and Bangla:
// the same keys, no empty text, the same {placeholders}, and a label for every
// provider kind the platform has.
import { describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "@scalius/shared/plugins/providers/kinds";
import { appKindsMessages } from "./settings-app-kinds";
import { appSurfacesMessages } from "./app-surfaces";
import { installedAppsMessages } from "./apps";
import { notificationsMessages } from "./settings-notifications";
import { settingsMarketsMessages } from "./settings-markets";
import { webPushMessages } from "./settings-web-push";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]).sort();

function expectComplete(name: string, catalog: { en: Record<string, string>; bn: Record<string, string> }, keys?: readonly string[]) {
  const wanted = keys ?? Object.keys(catalog.en);
  for (const key of wanted) {
    const en = catalog.en[key];
    const bn = catalog.bn[key];
    expect(en, `${name}.en.${key}`).toBeTruthy();
    expect(bn, `${name}.bn.${key}`).toBeTruthy();
    expect(placeholders(bn!), `${name}.${key} placeholders`).toEqual(placeholders(en!));
  }
  if (!keys) expect(Object.keys(catalog.bn).sort()).toEqual(Object.keys(catalog.en).sort());
}

describe("Wave 7 catalogs", () => {
  it("are complete in English and Bangla", () => {
    expectComplete("appKinds", appKindsMessages);
    expectComplete("webPush", webPushMessages);
    expectComplete("settingsMarkets", settingsMarketsMessages, [
      "rateSource", "rateSourceManual", "rateSourceByApp", "rateSourceManualHelp", "rateSourceAppHelp", "rateFromApp", "rateFromAppOnSave",
    ]);
    expectComplete("notifications", notificationsMessages, ["browser"]);
  });

  it("label every provider kind the platform has, for the app page and for search", () => {
    expectComplete("appSurfaces", appSurfacesMessages, PROVIDER_KINDS.map((kind) => `kind_${kind}`));
    expectComplete("apps", installedAppsMessages, PROVIDER_KINDS.map((kind) => `provider_${kind}`));
  });
});
