// The demo store's part of the storefront theme: the slides of the homepage's
// first hero section and the collection ids of its first collections section.
// Everything else in the theme (look, brand, words, other sections) belongs to
// the merchant and is carried over from the published theme unchanged.

const NO_DEMO_HOMEPAGE = Object.freeze({ slides: [], collectionIds: [] });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function homepageSections(theme) {
  const home = Array.isArray(theme?.pages?.home) ? theme.pages.home : [];
  return {
    hero: home.findIndex((section) => section?.type === "hero"),
    collections: home.findIndex((section) => section?.type === "collections"),
  };
}

/** `theme` with the demo store's slides and collection ids; both sections must exist. */
export function themeWithDemoHomepage(theme, { slides, collectionIds }) {
  const { hero, collections } = homepageSections(theme);
  if (hero < 0 || collections < 0) {
    throw new Error("The storefront theme needs a hero section and a collections section on its homepage.");
  }
  return {
    ...theme,
    pages: {
      ...theme.pages,
      home: theme.pages.home.map((section, index) => {
        if (index === hero) return { ...section, settings: { ...section.settings, slides } };
        if (index === collections) return { ...section, settings: { ...section.settings, collectionIds } };
        return section;
      }),
    },
  };
}

/**
 * Why the theme workspace cannot take the demo homepage (null when it can):
 * the published and draft revisions must be readable, the draft must be based
 * on the live revision and differ from the live theme at most in the demo
 * store's own slides and collections (an interrupted apply's staged draft),
 * and both need a hero and a collections section. A draft with any other
 * unpublished change is the merchant's work and is never overwritten.
 */
export function demoThemeBlocker(workspace) {
  const published = workspace?.published;
  const draft = workspace?.draft;
  const revisions = [published?.revision, draft?.revision, draft?.basePublishedRevision];
  if (!revisions.every((revision) => Number.isSafeInteger(revision) && revision >= 0)
    || draft.basePublishedRevision !== published.revision) {
    return {
      code: "THEME_REVISION_MISSING",
      message: "Theme publication requires the current published and draft revisions, with the draft based on the live theme.",
    };
  }
  for (const theme of [published.theme, draft.theme]) {
    const { hero, collections } = homepageSections(theme);
    if (hero < 0 || collections < 0) {
      return {
        code: "THEME_SECTION_MISSING",
        message: "The storefront theme needs a hero section and a collections section on its homepage before the demo store can fill them.",
      };
    }
  }
  const draftLook = canonical(themeWithDemoHomepage(draft.theme, NO_DEMO_HOMEPAGE));
  const liveLook = canonical(themeWithDemoHomepage(published.theme, NO_DEMO_HOMEPAGE));
  if (JSON.stringify(draftLook) !== JSON.stringify(liveLook)) {
    return {
      code: "THEME_DRAFT_UNPUBLISHED",
      message: "The storefront theme draft has unpublished changes. Publish or undo them in the dashboard before applying the demo store.",
    };
  }
  return null;
}

export function assertDemoThemeWorkspace(workspace) {
  const blocker = demoThemeBlocker(workspace);
  if (blocker) throw new Error(blocker.message);
  return workspace;
}
