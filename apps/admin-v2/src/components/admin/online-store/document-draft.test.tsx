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
});
