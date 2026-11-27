// Two kinds of manifest check, on two sides of one seam.
//
// - Structure (`parsePluginManifest`): the shape the platform needs to run an
//   app. It runs on EVERY read of a stored manifest (an installation row is
//   parsed again each time it is loaded), so a stored manifest that stops
//   parsing stops the app. It only ever changes additively.
// - Policy (`pluginManifestPolicyIssues`, here): what a release must meet to
//   be installed, updated or packed: supported object patterns, buyer words
//   that never pass for the store's (store-words.ts), and `buyerPages` only on
//   a header or footer skin (the pack and the upload also check the sheet such
//   a skin is drawn with, storefront-files.ts). It runs only when
//   a release changes what the store runs (install, update, build, validate,
//   the test harness), never when a stored manifest is read, so tightening a
//   policy never stops an app already installed: its next release meets it.
import { storeWordsIssues, type StoreWordsLabel } from "../store-words";
import { pluginObjectPatternIssues } from "./object-patterns";
import type { PluginManifest } from "./manifest";

export interface PluginManifestPolicyIssue {
  path: string;
  message: string;
  reason?: string;
}

/** The buyer's checkout words a manifest declares (and their translations), each with its label kind. */
function checkoutLabels(manifest: Pick<PluginManifest, "checkout" | "translations">): StoreWordsLabel[] {
  const labels: StoreWordsLabel[] = [];
  const { attributes = [], lineInputs = [], purchaseOptions = [] } = manifest.checkout ?? {};
  for (const [index, attribute] of attributes.entries()) {
    const at = ["checkout", "attributes", index];
    labels.push({ text: attribute.label, at: [...at, "label"], kind: "input-label" }, { text: attribute.help, at: [...at, "help"], kind: "help" });
    for (const [choice, option] of (attribute.choices ?? []).entries()) labels.push({ text: option.label, at: [...at, "choices", choice, "label"], kind: "choice" });
  }
  for (const [index, input] of lineInputs.entries()) {
    const at = ["checkout", "lineInputs", index];
    labels.push({ text: input.label, at: [...at, "label"], kind: "input-label" }, { text: input.help, at: [...at, "help"], kind: "help" });
    for (const [option, entry] of (input.options ?? []).entries()) {
      labels.push(
        { text: entry.label, at: [...at, "options", option, "label"], kind: "choice" },
        { text: entry.confirm?.title, at: [...at, "options", option, "confirm", "title"], kind: "input-label" },
        { text: entry.confirm?.agree, at: [...at, "options", option, "confirm", "agree"], kind: "agreement" },
      );
    }
    labels.push(
      { text: input.bulk?.apply?.label, at: [...at, "bulk", "apply", "label"], kind: "bulk-action" },
      { text: input.bulk?.clear?.label, at: [...at, "bulk", "clear", "label"], kind: "bulk-action" },
    );
  }
  for (const [index, option] of purchaseOptions.entries()) labels.push({ text: option.title, at: ["checkout", "purchaseOptions", index, "title"], kind: "purchase-option" });
  for (const [tag, translation] of Object.entries(manifest.translations ?? {})) {
    const words = translation.checkout;
    if (!words) continue;
    const at = ["translations", tag, "checkout"];
    for (const [key, attribute] of Object.entries(words.attributes ?? {})) {
      labels.push({ text: attribute.label, at: [...at, "attributes", key, "label"], kind: "input-label" }, { text: attribute.help, at: [...at, "attributes", key, "help"], kind: "help" });
      for (const [value, choice] of Object.entries(attribute.choices ?? {})) labels.push({ text: choice, at: [...at, "attributes", key, "choices", value], kind: "choice" });
    }
    for (const [key, input] of Object.entries(words.lineInputs ?? {})) {
      labels.push({ text: input.label, at: [...at, "lineInputs", key, "label"], kind: "input-label" }, { text: input.help, at: [...at, "lineInputs", key, "help"], kind: "help" });
      for (const [value, option] of Object.entries(input.options ?? {})) labels.push({ text: option, at: [...at, "lineInputs", key, "options", value], kind: "choice" });
      for (const [value, confirm] of Object.entries(input.confirm ?? {})) {
        labels.push(
          { text: confirm.title, at: [...at, "lineInputs", key, "confirm", value, "title"], kind: "input-label" },
          { text: confirm.agree, at: [...at, "lineInputs", key, "confirm", value, "agree"], kind: "agreement" },
        );
      }
      labels.push(
        { text: input.bulk?.apply, at: [...at, "lineInputs", key, "bulk", "apply"], kind: "bulk-action" },
        { text: input.bulk?.clear, at: [...at, "lineInputs", key, "bulk", "clear"], kind: "bulk-action" },
      );
    }
    for (const [key, option] of Object.entries(words.purchaseOptions ?? {})) labels.push({ text: option.title, at: [...at, "purchaseOptions", key, "title"], kind: "purchase-option" });
  }
  return labels;
}

/**
 * What a release must meet to be installed, updated or packed, beyond its
 * structure: supported object patterns, and checkout words that never pass
 * for the store's (reason `store_words`). Never run on a stored manifest's read.
 */
export function pluginManifestPolicyIssues(manifest: PluginManifest): PluginManifestPolicyIssue[] {
  return [
    ...pluginObjectPatternIssues(manifest),
    // A skin of another target is never drawn there (the read ignores the flag); a release that asks for it is refused.
    ...(manifest.storefront?.skins ?? []).flatMap((skin, index) => skin.buyerPages && skin.target !== "header" && skin.target !== "footer"
      ? [{ path: `storefront.skins.${index}.buyerPages`, message: "Only a header or footer skin draws on the buyer's own pages." }]
      : []),
    ...storeWordsIssues(checkoutLabels(manifest)).map((issue) => ({ path: issue.path.join("."), message: issue.message, reason: issue.reason })),
  ];
}
