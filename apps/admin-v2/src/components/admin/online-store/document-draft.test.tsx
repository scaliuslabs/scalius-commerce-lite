// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useDocumentDraft } from "./shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Preferences {
  homepageTitle: string;
  homepageMetaDescription: string;
  productCatalogEnabled: boolean;
}

describe("online store document draft", () => {
  it("loads a newer saved version under the draft: the merchant's edits stay, untouched fields update", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const hook: { current: ReturnType<typeof useDocumentDraft<Preferences>> | null } = { current: null };
    function Card({ saved }: { saved: Preferences }) {
      hook.current = useDocumentDraft<Preferences>({ label: "Preferences", saved, save: async () => {} });
      return null;
    }
    const opened = { homepageTitle: "Shop", homepageMetaDescription: "Old", productCatalogEnabled: true };
    act(() => root.render(<Card saved={opened} />));
    act(() => hook.current!.setDraft((draft) => ({ ...draft, homepageTitle: "My shop" })));

    // Someone else turned the product feed off and rewrote the description.
    const theirs = { homepageTitle: "Shop", homepageMetaDescription: "Theirs", productCatalogEnabled: false };
    act(() => root.render(<Card saved={theirs} />));
    expect(hook.current!.draft).toEqual({
      homepageTitle: "My shop",
      homepageMetaDescription: "Theirs",
      productCatalogEnabled: false,
    });
    expect(hook.current!.dirty).toBe(true);

    // A clean draft simply follows the saved version.
    act(() => hook.current!.setDraft(theirs));
    const later = { ...theirs, homepageTitle: "Later" };
    act(() => root.render(<Card saved={later} />));
    expect(hook.current!.draft).toEqual(later);
    expect(hook.current!.dirty).toBe(false);

    act(() => root.unmount());
  });

  it("keeps nested edits too: one checkout text changed here, another there", async () => {
    const { rebaseDraft } = await import("./shared");
    const opened = { name: "English", languageData: { pageTitle: "Checkout", placeOrderText: "Place order" } };
    const mine = { ...opened, languageData: { ...opened.languageData, pageTitle: "Pay" } };
    const theirs = { ...opened, languageData: { ...opened.languageData, placeOrderText: "Confirm order" } };
    expect(rebaseDraft(mine, opened, theirs)).toEqual({
      name: "English",
      languageData: { pageTitle: "Pay", placeOrderText: "Confirm order" },
    });
  });

  it("writes a menu web address once: no doubled https://, a scheme added to a bare domain", async () => {
    const { isWebAddress, normalizeWebAddress } = await import("./shared");
    expect(normalizeWebAddress("https://https://example.com/blog")).toBe("https://example.com/blog");
    expect(normalizeWebAddress("https://https//example.com/blog")).toBe("https://example.com/blog");
    expect(normalizeWebAddress(" example.com ")).toBe("https://example.com");
    expect(normalizeWebAddress("http://shop.example.com")).toBe("http://shop.example.com");
    expect(normalizeWebAddress("https://")).toBe("");
    expect(isWebAddress("https://")).toBe(false);
    expect(isWebAddress("hello")).toBe(false);
    expect(isWebAddress("example.com/blog")).toBe(true);
  });

  it("keeps a removed field removed: Ocean → Classic (no custom colours) never leaves undefined colours", async () => {
    const { rebaseDraft } = await import("./shared");
    const ocean = { colors: { background: "#f0f9ff", primary: "#0369a1" }, cornerStyle: "rounded" };
    const classic = { colors: {}, cornerStyle: "subtle" };
    // After saving Classic the saved document is the draft itself.
    const afterSave = rebaseDraft(classic, ocean, structuredClone(classic));
    expect(afterSave).toEqual(classic);
    expect(Object.values(afterSave.colors)).toEqual([]);
    // Someone else's newer save under an unsaved Classic pick: their untouched fields, none of Ocean's colours.
    const theirs = { colors: { background: "#ffffff", primary: "#0369a1" }, cornerStyle: "rounded" };
    const rebased = rebaseDraft(classic, ocean, theirs);
    expect(rebased).toEqual({ colors: {}, cornerStyle: "subtle" });
    expect(Object.values(rebased.colors).every((value) => typeof value === "string")).toBe(true);
  });
});
