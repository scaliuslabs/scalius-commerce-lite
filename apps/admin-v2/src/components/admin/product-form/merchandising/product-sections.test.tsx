// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ProductSectionsProvider, useProductSection, useProductSections } from "./product-sections";
import { useSectionDraft } from "./use-section-draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("product section conflict rebase", () => {
  it("retains all dirty sections, refreshes clean sections, and refuses an overlapping save without losing drafts", async () => {
    const root = createRoot(document.createElement("div"));
    const drafts = new Map<string, ReturnType<typeof useSectionDraft<string>>>();
    let sections!: ReturnType<typeof useProductSections>;
    const latest = new Map([["Content", "old content"], ["Bundles", "old bundles"], ["Page", "old page"]]);
    function Section({ label }: { label: string }) {
      const state = useSectionDraft(`old ${label.toLowerCase()}`);
      drafts.set(label, state);
      useProductSection({
        label, dirty: state.dirty, problems: null, save: async (revision) => revision + 1,
        prepareRebase: async () => () => state.prepareRebase(latest.get(label)!),
      });
      return null;
    }
    function Editor() {
      sections = useProductSections();
      return <ProductSectionsProvider registry={sections.registry}>
        {[...latest.keys()].map((label) => <Section key={label} label={label} />)}
      </ProductSectionsProvider>;
    }
    act(() => root.render(<Editor />));
    act(() => {
      drafts.get("Content")!.setDraft("my content");
      drafts.get("Bundles")!.setDraft("my bundles");
    });
    latest.set("Page", "their page");
    const allowed = await sections.prepareRebase();
    expect(allowed.overlaps).toEqual([]);
    act(() => allowed.apply());
    expect(drafts.get("Content")!.draft).toBe("my content");
    expect(drafts.get("Bundles")!.draft).toBe("my bundles");
    expect(drafts.get("Page")!.draft).toBe("their page");
    expect(sections.dirtyHandles().map((handle) => handle.label)).toEqual(["Content", "Bundles"]);

    latest.set("Content", "their content");
    const refused = await sections.prepareRebase();
    expect(refused.overlaps).toEqual(["Content"]);
    expect(drafts.get("Content")!.saved).toBe("old content");
    expect(drafts.get("Content")!.draft).toBe("my content");
    // Repeated Apply must not move the baseline and silently allow the overwrite.
    expect((await sections.prepareRebase()).overlaps).toEqual(["Content"]);
    act(() => root.unmount());
  });

  it("checks edits made while another section is still loading against the original baseline", async () => {
    const root = createRoot(document.createElement("div"));
    let section!: ReturnType<typeof useSectionDraft<string>>;
    let sections!: ReturnType<typeof useProductSections>;
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    function Cards() {
      section = useSectionDraft("old");
      useProductSection({
        label: "Content", dirty: section.dirty, problems: null, save: async (revision) => revision,
        prepareRebase: async () => () => section.prepareRebase("theirs"),
      });
      useProductSection({
        label: "Page", dirty: false, problems: null, save: async (revision) => revision,
        prepareRebase: async () => { await waiting; return () => () => {}; },
      });
      return null;
    }
    function Editor() {
      sections = useProductSections();
      return <ProductSectionsProvider registry={sections.registry}><Cards /></ProductSectionsProvider>;
    }
    act(() => root.render(<Editor />));
    const pending = sections.prepareRebase();
    await Promise.resolve();
    act(() => section.setDraft("typed while loading"));
    finish();
    expect((await pending).overlaps).toEqual(["Content"]);
    expect(section.draft).toBe("typed while loading");
    expect(section.saved).toBe("old");
    act(() => root.unmount());
  });
});
