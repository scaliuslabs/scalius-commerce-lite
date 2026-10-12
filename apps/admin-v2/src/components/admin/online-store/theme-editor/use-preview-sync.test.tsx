// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontSectionDefault, type StorefrontSection, type StorefrontSectionType, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { PREVIEW_RENDER_DELAY_MS, usePreviewSync } from "./use-preview-sync";
import type { EditorPage } from "./editor-pages";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Props = Parameters<typeof usePreviewSync>[0];
const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;
const theme = (sections: StorefrontSection[]): StorefrontThemeDocument => ({
  ...DEFAULT_STOREFRONT_THEME, pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: sections, homeMode: { kind: "sections" } },
});
let root: Root;
let container: HTMLDivElement;
let props: Props;
const send = vi.fn();
const reload = vi.fn();
const needSave = vi.fn();
function Harness(input: Props) { usePreviewSync(input); return null; }
function update(next: Partial<Props>) {
  props = { ...props, ...next };
  act(() => root.render(<Harness {...props} />));
}
function start(savedTheme: StorefrontThemeDocument, page: EditorPage = { kind: "home" }, marks?: string[]) {
  props = { send, reload, onNeedSave: needSave, fieldsEnabled: true, connectedAt: 1, working: savedTheme,
    sendable: savedTheme, savedTheme, page, presence: null, marks: marks ?? savedTheme.pages.home.map(each => each.id) };
  update({});
}
function tick() { act(() => vi.advanceTimersByTime(PREVIEW_RENDER_DELAY_MS + 1)); }
const renders = () => send.mock.calls.map(([command]) => command).filter(command => command.type === "render");
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("preview document synchronization", () => {
  it("sends a combined reorder and settings edit at one document revision", () => {
    const a = section("faq", "a", { heading: "Old" });
    const b = section("faq", "b", { heading: "Other" });
    start(theme([a, b]));
    const next = theme([b, section("faq", "a", { heading: "New" })]);
    update({ working: next, sendable: next }); tick();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "arrange", order: ["b", "a"] }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "text", id: "a", field: "heading", value: "New" }));
    expect(renders()).toEqual([expect.objectContaining({ body: expect.objectContaining({ only: "a", region: "page" }), after: "b" })]);
    expect(new Set(send.mock.calls.map(([command]) => command.revision)).size).toBe(1);
  });

  it.each(["hide", "swap", "layout"])("uses canonical regions for grouped-banner %s", (change) => {
    const a = section("banner", "a", { layout: "two-up" });
    const b = section("banner", "b", { layout: "two-up" });
    start(theme([a, b]));
    const next = theme(change === "hide" ? [{ ...a, hidden: true }, b] : change === "swap" ? [b, a]
      : [section("banner", "a", { layout: "full" }), b]);
    update({ working: next, sendable: next }); tick();
    expect(send.mock.calls.some(([command]) => command.type === "arrange")).toBe(false);
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.sections).toEqual(next.pages.home);
    expect(renders()[0].body.only).toBeUndefined();
  });

  it("refreshes phone ordering when a sibling's settings change its visibility", () => {
    const hero = section("hero", "hero", { phonePlacement: "after-categories" });
    const tiles = section("category-tiles", "tiles", { categoryIds: ["a", "b"] });
    start(theme([hero, tiles]));
    const next = theme([hero, section("category-tiles", "tiles", { categoryIds: [] })]);
    update({ working: next, sendable: next }); tick();
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.only).toBeUndefined();
  });

  it("renders only the edited FAQ beside a phone-placed hero", () => {
    const hero = section("hero", "hero", { phonePlacement: "after-categories" });
    const tiles = section("category-tiles", "tiles", { categoryIds: ["a", "b"] });
    const faq = section("faq", "faq", { heading: "Old", items: [{ question: "Where?", answer: "Here." }] });
    start(theme([hero, tiles, faq]));
    const next = theme([hero, tiles, { ...faq, settings: { ...faq.settings, heading: "New" } } as StorefrontSection]);
    update({ working: next, sendable: next }); tick();
    expect(renders()).toEqual([expect.objectContaining({ body: expect.objectContaining({ only: "faq", region: "page" }), after: "tiles" })]);
  });

  it("still reconciles phone placement when hero settings change", () => {
    const hero = section("hero", "hero", { phonePlacement: "after-categories" });
    const tiles = section("category-tiles", "tiles", { categoryIds: ["a", "b"] });
    start(theme([hero, tiles]));
    const next = theme([section("hero", "hero", { phonePlacement: "after-categories", layout: "wide-editorial" }), tiles]);
    update({ working: next, sendable: next }); tick();
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.only).toBeUndefined();
  });

  it.each(["page", "before", "after"])("renders the exact region order when an empty %s section gains content", (region) => {
    const a = section("faq", "a", { heading: "" });
    const b = section("faq", "b");
    const saved = theme([a, b]);
    const page: EditorPage = region === "page" ? { kind: "home" } : { kind: "cart" };
    if (region !== "page") saved.pages = { ...saved.pages, templates: { ...saved.pages.templates, cart: { sections: [a, b], main: region === "before" ? 2 : 0 } } };
    start(saved, page, ["b"]);
    const updated = section("faq", "a", { heading: "Now visible" });
    const next = region === "page" ? theme([updated, b]) : { ...saved, pages: { ...saved.pages, templates: {
      ...saved.pages.templates, cart: { ...saved.pages.templates.cart, sections: [updated, b] },
    } } };
    update({ working: next, sendable: next }); tick();
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.only).toBeUndefined();
    expect(renders()[0].body.sections.map((each: StorefrontSection) => each.id)).toEqual(["a", "b"]);
    expect(renders()[0].body.scope).toMatchObject(region === "page" ? { kind: "home" } : { kind: "template", template: "cart", main: region === "before" ? 2 : 0 });
    expect(reload).not.toHaveBeenCalled();
  });

  it("cancels pending mutations and sends nothing while historical mode is active", () => {
    start(theme([section("faq", "a", { heading: "Old" })]));
    const next = theme([section("faq", "a", { heading: "New" })]);
    update({ working: next, sendable: next });
    send.mockClear();
    update({ enabled: false, sendable: null }); tick();
    update({ working: theme([section("faq", "a", { heading: "Historical must stay" })]), resyncAt: 1 }); tick();
    expect(send).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(needSave).not.toHaveBeenCalled();
  });

  it("reconciles one latest snapshot after stale replies instead of replaying older unit edits", () => {
    start(theme([section("faq", "a", { heading: "Old" })]));
    const next = theme([section("faq", "a", { heading: "Latest" })]);
    update({ working: next, sendable: next }); tick(); send.mockClear();
    update({ resyncAt: 1 }); update({ resyncAt: 2 }); tick();
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.sections).toEqual(next.pages.home);
    expect(renders()[0].body.only).toBeUndefined();
    expect(send.mock.calls.filter(([command]) => command.type === "paint")).toHaveLength(1);
    send.mockClear(); update({ savedTheme: next }); tick();
    expect(send).not.toHaveBeenCalled();
  });
  it("does no preview work for hidden settings until the section is shown", () => {
    const hidden = { ...section("faq", "a", { heading: "Old" }), hidden: true };
    const visible = section("faq", "b");
    start(theme([hidden, visible]), { kind: "home" }, ["b"]);
    const edited = { ...section("faq", "a", { heading: "New" }), hidden: true };
    const next = theme([edited, visible]);
    update({ working: next, sendable: next }); tick();
    expect(send).not.toHaveBeenCalled();
    const shown = theme([{ ...edited, hidden: false }, visible]);
    update({ working: shown, sendable: shown }); tick();
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.sections).toEqual(shown.pages.home);
    expect(renders()[0].body.only).toBeUndefined();
  });

  it("keeps a separately scheduled paint when grouped structure needs regions", () => {
    const a = section("banner", "a", { layout: "two-up" });
    const b = section("banner", "b", { layout: "two-up" });
    const saved = theme([a, b]); start(saved);
    const key = Object.keys(saved.tokens.colors)[0] as keyof typeof saved.tokens.colors;
    const painted = { ...saved, tokens: { ...saved.tokens, colors: { ...saved.tokens.colors, [key]: "#123456" } } };
    update({ working: painted, sendable: painted });
    const reordered = { ...painted, pages: { ...painted.pages, home: [b, a] } };
    update({ working: reordered, sendable: reordered }); tick();
    expect(renders()).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command.type === "paint")).toEqual([
      [expect.objectContaining({ theme: reordered })],
    ]);
  });

});

describe("field patches and canonical fallback", () => {
  it("addresses duplicate words by field and matches renderer trimming", () => {
    start(theme([section("banner", "a", { heading: "Same", text: "Same", cta: { label: "Same", href: "/" } })]));
    const next = theme([section("banner", "a", { heading: "  Changed  ", text: "Same", cta: { label: "Same", href: "/" } })]);
    update({ working: next, sendable: next });
    expect(send.mock.calls.filter(([command]) => command.type === "text").map(([command]) => command)).toEqual([
      expect.objectContaining({ id: "a", field: "heading", value: "Changed" }),
    ]);
    tick(); expect(renders()).toHaveLength(1);
  });
  it.each(["legacy", "empty", "body", "list"])("keeps %s on canonical rendering, without guessing at text nodes", (kind) => {
    const before = kind === "body" ? section("editorial", "a", { layout: "rich-text", heading: "Heading", body: "First\n\nSecond" })
      : section("faq", "a", { heading: "Heading", items: [{ question: "Q", answer: "A" }] });
    start(theme([before]));
    if (kind === "legacy") update({ fieldsEnabled: false });
    const next = theme([{ ...before, settings: { ...before.settings,
      ...(kind === "body" ? { body: "Next\n\nLast" } : kind === "list" ? { items: [{ question: "Changed", answer: "A" }] } : { heading: kind === "empty" ? "" : "Changed" }),
    } } as StorefrontSection]);
    update({ working: next, sendable: next }); tick();
    expect(send.mock.calls.some(([command]) => command.type === "text")).toBe(false);
    expect(renders()).toHaveLength(1);
    expect(renders()[0].body.only).toBe("a");
  });
});
