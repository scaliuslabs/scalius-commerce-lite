import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/shared/plugins/manifest";
import { manifest } from "./index";

describe("Nagad settings translation", () => {
  it("covers every field, help and option within the manifest bounds", () => {
    const parsed = parsePluginManifest(manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const bn = parsed.manifest.translations!.bn!;
    expect(Object.keys(bn.settings!).sort()).toEqual(parsed.manifest.settings.map((field) => field.key).sort());
    for (const field of parsed.manifest.settings) {
      const text = bn.settings![field.key]!;
      expect(text.label).toBeTruthy();
      if (field.help) expect(text.help).toBeTruthy();
      if (field.type === "select" || field.type === "multiselect") {
        expect(Object.keys(text.options!).sort()).toEqual(field.options.map((option) => option.value).sort());
      }
    }
    expect(bn.name).toContain("যাচাই করা হয়নি");
    expect(parsed.manifest.name).toBe("Nagad (unverified)");
  });

  it("preserves credential and protocol literals in the Bengali instructions", () => {
    const text = manifest.translations.bn.settings;
    for (const token of ["01XXXXXXXXX", "accountNumber"]) expect(text.merchant_number.help).toContain(token);
    for (const token of ["RSA", "PKCS#8 PEM", "-----BEGIN PRIVATE KEY-----"]) expect(text.merchant_private_key.help).toContain(token);
    for (const token of ["-----BEGIN PUBLIC KEY-----", "base64"]) expect(text.nagad_public_key.help).toContain(token);
    expect(text.server_ip.help).toContain("X-KM-IP-V4");
    expect(text.environment.options).toEqual({ sandbox: "স্যান্ডবক্স (পরীক্ষা)", live: "লাইভ" });
  });
});
