// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STOREFRONT_SECTION_RENDERERS, storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { resolvePluginSettingValues, pluginSettingsSchemaSchema } from "@scalius/shared/plugins/settings-schema";
import { setLocale } from "~/i18n";
import { SectionLibrary } from "./SectionLibrary";
import { newAppSection, newSection } from "./editor-state";
import { appSettingDefaults } from "../schema-form/app-settings";
import { readLibrarySelection } from "../../../../../../storefront/src/lib/theme-preview-library";

const viewport = vi.hoisted(() => ({ desktop: true }));
vi.mock("~/hooks/use-media-query", () => ({ useMediaQuery: () => viewport.desktop }));
vi.mock("./SectionLibraryPreview", () => ({ SectionLibraryPreview: ({ selection }: { selection: string }) => <div data-real-preview={selection} /> }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
const add = vi.fn();
const close = vi.fn();
const theme = storefrontTemplateTheme("department-mall");
beforeEach(() => {
  vi.clearAllMocks(); viewport.desktop = true; setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function render(open = true) {
  act(() => root.render(<SectionLibrary open={open} onOpenChange={close} theme={theme}
    options={[{ choice: { type: "faq" }, blocked: null }, { choice: { type: "editorial" }, blocked: null }, { choice: { type: "hero" }, blocked: "Already present" }]}
    apps={[]} aiAvailable={false} onAdd={add} onDraftWithAi={() => {}}
    preview={{ ready: true, origin: "https://shop.test", path: "/", revision: 1, retry: () => {} }} />));
}
const tile = (key: string) => document.querySelector<HTMLButtonElement>(`[data-library-item="${key}"]`)!;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === label || each.getAttribute("aria-label") === label)!;

describe("library selection and insertion", () => {
  it("browses and closes without adding; only explicit Add calls the insertion callback", () => {
    const snapshot = JSON.stringify(theme);
    render(); act(() => tile("faq").click());
    expect(add).not.toHaveBeenCalled();
    expect(document.querySelector("[data-real-preview]")?.getAttribute("data-real-preview")).toBe("faq");
    act(() => button("Close").click()); expect(add).not.toHaveBeenCalled();
    render(false); expect(document.querySelector("[data-real-preview]")).toBeNull();
    render(); act(() => tile("editorial").click());
    const insert = [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.startsWith("Add ") && !each.hasAttribute("data-library-item"))!;
    act(() => insert.click()); expect(add).toHaveBeenCalledExactlyOnceWith({ type: "editorial" });
    expect(JSON.stringify(theme)).toBe(snapshot);
  });
  it("keeps desktop arrow focus on selected radio and honors blocked Add", () => {
    render(); act(() => { tile("faq").focus(); tile("faq").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(document.activeElement).toBe(tile("editorial"));
    expect(tile("editorial").getAttribute("aria-checked")).toBe("true");
    act(() => tile("hero").click());
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.startsWith("Add ") && !each.hasAttribute("data-library-item"))?.disabled).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });
  it("moves phone focus to Back, then restores the selected radio without losing selection", () => {
    viewport.desktop = false; render(); act(() => tile("faq").click());
    expect(document.activeElement).toBe(button("Back to sections"));
    act(() => button("Back to sections").click());
    expect(document.activeElement).toBe(tile("faq"));
    expect(tile("faq").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-real-preview]")).toBeNull();
  });
});

describe("preview and Add default parity", () => {
  const selection = (key: string) => readLibrarySelection(new URL(`https://shop.test/theme-preview/library?${new URLSearchParams({ section: key, page: "/", v: "test" })}`))!.section;
  it.each(STOREFRONT_SECTION_RENDERERS)("previews precisely the new %s section", (type) => {
    expect({ ...selection(type), id: type }).toEqual(newSection(type, []));
  });
  it("uses the same app defaults after the authoritative resolver fills an empty placement", () => {
    const schema = pluginSettingsSchemaSchema.parse([{ key: "heading", label: "Heading", type: "text", default: "Hello" }]);
    const fields = [{ key: "heading", label: "Heading", type: "text" as const, default: "Hello", required: false, help: null, options: null, min: null, max: null, integer: false, maxLength: 500 }];
    const expected = newAppSection("acme.theme/hero", appSettingDefaults(fields), []);
    const actual = selection("acme.theme/hero");
    expect(actual.type).toBe("app");
    if (actual.type === "app") expect({ ...actual, id: expected.id, settings: { ...actual.settings, values: resolvePluginSettingValues(schema, actual.settings.values) } }).toEqual(expected);
  });
});
