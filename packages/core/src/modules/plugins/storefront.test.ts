// Which app scripts the storefront loads: only active apps', only the hosts a
// Super Admin approved (an update that adds a host loads nothing new until
// it is approved), only https.
import { describe, expect, it } from "vitest";
import { parsePluginManifest, PLUGIN_API_VERSION, pluginGrantRequest } from "@scalius/shared/plugins";
import { activePluginStorefrontScripts } from "./storefront";
import type { PluginInstallation } from "./installations";

function installation(id: string, scripts: Array<{ src: string; pages?: string[] }>, grantedFrom: Array<{ src: string }> = scripts): PluginInstallation {
  const parse = (list: Array<{ src: string; pages?: string[] }>) => {
    const parsed = parsePluginManifest({
      id, name: id, version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "An app.", author: { name: "Acme" },
      storefront: { scripts: list },
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.manifest;
  };
  const manifest = parse(scripts);
  return {
    pluginId: id, version: "1.0.0", source: "bundled", bundleSha256: "a".repeat(64), manifest, declaredManifest: manifest, features: [],
    grant: pluginGrantRequest(parse(grantedFrom)), grantKey: "k", status: "active", failureReason: null,
    storedSettings: {}, revision: 1, installedBy: null, activatedBy: "owner", installedAt: 1, activatedAt: 1, updatedAt: 1,
    migratedVersion: 0, signerKeyId: null, storageBytes: 0, storageMeasuredAt: null,
  };
}

describe("storefront scripts of active apps", () => {
  it("lists approved scripts with their pages and placement, in app id order", () => {
    expect(activePluginStorefrontScripts([
      installation("acme.zeta", [{ src: "https://cdn.zeta.example/z.js", pages: ["product"] }]),
      installation("acme.alpha", [{ src: "https://cdn.alpha.example/a.js" }]),
    ])).toEqual([
      { pluginId: "acme.alpha", src: "https://cdn.alpha.example/a.js", placement: "body-end", pages: ["all"] },
      { pluginId: "acme.zeta", src: "https://cdn.zeta.example/z.js", placement: "body-end", pages: ["product"] },
    ]);
  });

  it("loads nothing from a host the approved grant does not cover", () => {
    const updated = installation(
      "acme.widget",
      [{ src: "https://cdn.widget.example/w.js" }, { src: "https://new.widget.example/n.js" }],
      [{ src: "https://cdn.widget.example/w.js" }],
    );
    expect(activePluginStorefrontScripts([updated]).map((script) => script.src)).toEqual(["https://cdn.widget.example/w.js"]);
    expect(activePluginStorefrontScripts([{ ...updated, grant: null }])).toEqual([]);
  });
});
