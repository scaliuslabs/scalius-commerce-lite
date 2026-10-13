import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UpdateProductInput } from "~/lib/api-query-options/products";

/** What a section adds to the product's one write (only what changed). */
export type ProductSectionChanges = Partial<Pick<UpdateProductInput, "contentBlocks" | "bundles" | "pageTemplate" | "emiEligible">>;

/**
 * A product editor section with its own draft (content blocks, bundles,
 * template): the page's Save sends its changes in the product's one write.
 */
export interface ProductSectionHandle {
  /** Names the section in the save banner. */
  label: string;
  dirty: boolean;
  /** Retained draft protection when this section is temporarily view-only. Defaults to dirty. */
  navigationDirty?: boolean;
  /** Problems that keep it from saving, one line each (null when it can save). */
  problems: string[] | null;
  /** Reads fresh state and checks overlap; applies it only after the whole page passes. */
  prepareRebase: () => Promise<() => (() => void) | null>;
  /** The draft's changes for this Save's write (the draft sent becomes the saved one on `saved`). */
  changes: () => ProductSectionChanges;
  /** After the write that carried `changes()`: what it sent is saved. */
  saved: () => void;
}

interface Registry {
  set(id: string, handle: ProductSectionHandle): void;
  remove(id: string): void;
}

const SectionsContext = createContext<Registry | null>(null);

/** Held by the product editor: the sections rendered inside it and whether any has edits. */
export function useProductSections() {
  const handles = useRef(new Map<string, ProductSectionHandle>());
  const [dirty, setDirty] = useState(false);
  const [navigationDirty, setNavigationDirty] = useState(false);
  const refresh = useCallback(() => {
    setDirty([...handles.current.values()].some((handle) => handle.dirty));
    setNavigationDirty([...handles.current.values()].some((handle) => handle.navigationDirty ?? handle.dirty));
  }, []);
  const registry = useMemo<Registry>(() => ({
    set(id, handle) {
      const previous = handles.current.get(id);
      handles.current.set(id, handle);
      if (previous?.dirty !== handle.dirty || (previous?.navigationDirty ?? previous?.dirty) !== (handle.navigationDirty ?? handle.dirty)) refresh();
    },
    remove(id) {
      if (handles.current.delete(id)) refresh();
    },
  }), [refresh]);
  const dirtyHandles = useCallback(() => [...handles.current.values()].filter((handle) => handle.dirty), []);
  const prepareRebase = useCallback(async () => {
    const loaded = await Promise.all([...handles.current.values()].map(async (handle) => ({
      label: handle.label,
      check: await handle.prepareRebase(),
    })));
    const checks = loaded.map(({ label, check }) => ({ label, apply: check() }));
    return {
      overlaps: checks.filter((check) => !check.apply).map((check) => check.label),
      apply: () => { for (const check of checks) check.apply?.(); },
    };
  }, []);
  return { registry, dirty, navigationDirty, dirtyHandles, prepareRebase };
}

export function ProductSectionsProvider({ registry, children }: { registry: Registry; children: ReactNode }) {
  return <SectionsContext.Provider value={registry}>{children}</SectionsContext.Provider>;
}

/** Registers a section with the product editor while it is mounted. */
export function useProductSection(handle: ProductSectionHandle) {
  const registry = useContext(SectionsContext);
  const id = useId();
  // The latest handle after every render, so the page always saves the latest draft.
  useLayoutEffect(() => {
    registry?.set(id, handle);
  });
  useEffect(() => () => registry?.remove(id), [registry, id]);
}
