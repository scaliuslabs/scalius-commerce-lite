// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  storefrontStylePresetTheme,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  footerQueryOptions,
  headerQueryOptions,
  themeQueryOptions,
} from "~/lib/api-query-options/online-store";
import { ThemePage } from "./ThemePage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ theme: vi.fn(), header: vi.fn(), footer: vi.fn() }));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminSettingsTheme: vi.fn(),
  getApiV1AdminSettingsHeader: vi.fn(),
  getApiV1AdminSettingsFooter: vi.fn(),
  postApiV1AdminSettingsTheme: api.theme,
  postApiV1AdminSettingsHeader: api.header,
  postApiV1AdminSettingsFooter: api.footer,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("~/components/admin/media-manager", () => ({ MediaManager: ({ trigger }: { trigger: ReactNode }) => trigger }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.theme.mockImplementation(async ({ body }: { body: { theme: StorefrontThemeDocument } }) => ({
    theme: body.theme,
    revision: 2,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(theme: StorefrontThemeDocument) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  queryClient.setQueryData(themeQueryOptions().queryKey, { theme, revision: 1 });
  queryClient.setQueryData(headerQueryOptions().queryKey, {
    config: { logo: { src: "", alt: "" }, favicon: { src: "", alt: "" }, topBar: { isEnabled: false } },
    revision: 1,
  } as never);
  queryClient.setQueryData(footerQueryOptions().queryKey, { config: { logo: { src: "", alt: "" } }, revision: 1 } as never);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <ThemePage />
        </Suspense>
      </QueryClientProvider>,
    );
  });
}

const headings = () => [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
const radio = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((item) => item.textContent?.startsWith(name))!;
const saveBar = () => document.querySelector("[data-save-bar]");
const pressSave = () =>
  act(async () => {
    [...document.querySelectorAll<HTMLButtonElement>("[data-save-bar] button")]
      .find((button) => button.textContent === "Save")!
      .click();
  });

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("theme page", () => {
  it("shows one card per choice, with the saved Style selected", () => {
    render(DEFAULT_STOREFRONT_THEME);
    expect(headings()).toEqual([
      "Style",
      "Logo",
      "Colors",
      "Header",
      "Footer",
      "Product cards",
      "Density",
      "Product page",
      "Homepage sections",
    ]);
    expect(radio("Classic retail").getAttribute("aria-checked")).toBe("true");
    expect(radio("Beauty").getAttribute("aria-checked")).toBe("false");
    // Previews are decorative; the radio's text names the choice.
    expect(radio("Beauty").querySelector("[aria-hidden=true]")).not.toBeNull();
    expect(saveBar()).toBeNull();
  });

  it("selecting a Style sets and saves the whole document", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    act(() => radio("Beauty").click());
    expect(radio("Beauty").getAttribute("aria-checked")).toBe("true");

    await pressSave();
    expect(api.theme).toHaveBeenCalledTimes(1);
    expect(api.theme.mock.calls[0]![0].body).toEqual({
      expectedRevision: 1,
      theme: storefrontStylePresetTheme("beauty"),
    });
  });

  it("names the Style a fine-tuned theme started from and confirms before replacing it", () => {
    const tuned = storefrontStylePresetTheme("beauty");
    tuned.layout = { ...tuned.layout, header: "marketplace" };
    render(tuned);
    // No Style matches exactly, so none is checked, and the page says where it started.
    expect(radio("Beauty").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Custom (based on Beauty)");

    act(() => radio("Classic retail").click());
    const dialog = document.querySelector("[role=alertdialog]");
    expect(dialog?.textContent).toContain("Replace your changes with Classic retail?");
    // Cancelling keeps the fine-tuned theme.
    act(() => [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(container.textContent).toContain("Custom (based on Beauty)");

    act(() => radio("Classic retail").click());
    act(() => [...document.querySelectorAll("[role=alertdialog] button")]
      .find((button) => button.textContent === "Replace")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(radio("Classic retail").getAttribute("aria-checked")).toBe("true");
  });

  it("names unreadable text in plain words and will not save it", async () => {
    render(DEFAULT_STOREFRONT_THEME);
    const buttonText = container.querySelector<HTMLInputElement>("#theme-color-button-text")!;
    type(buttonText, "#7AD08F");

    expect(buttonText.value).toBe("#7ad08f");
    expect(buttonText.getAttribute("aria-invalid")).toBe("true");
    const note = container.querySelector(`#${buttonText.getAttribute("aria-describedby")}`);
    expect(note?.textContent).toMatch(/^Button text is hard to read on the button color \(2\.\d:1, needs 4\.5:1\)\.$/);
    // The Style no longer matches: nothing is selected.
    expect(radio("Classic retail").getAttribute("aria-checked")).toBe("false");

    await pressSave();
    expect(api.theme).not.toHaveBeenCalled();

    // A readable colour clears the error and saves.
    type(buttonText, "#fafafa");
    expect(buttonText.hasAttribute("aria-invalid")).toBe(false);
    await pressSave();
    expect(api.theme).toHaveBeenCalledTimes(1);
  });

  it("a custom design shows the notice, hides the options and never offers to save the theme", () => {
    render({ ...DEFAULT_STOREFRONT_THEME, mode: "custom" });
    expect(container.querySelector("[data-slot=alert]")?.textContent).toBe(
      "This store uses a custom design, so the theme options are turned off. You can still change your logo.",
    );
    expect(headings()).toEqual(["Logo"]);
    expect(container.querySelector("[role=radio]")).toBeNull();
    expect(saveBar()).toBeNull();
  });
});
