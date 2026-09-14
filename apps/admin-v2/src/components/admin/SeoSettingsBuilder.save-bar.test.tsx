// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";
import { DEFAULT_SEO_RETURN_POLICY_SETTINGS } from "@scalius/shared/seo-return-policy";

import { SeoSettingsBuilder } from "./SeoSettingsBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const formState = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  isLoading: false,
  isLoaded: true,
  isLoadError: false,
  loadError: null as unknown,
  isSaving: false,
  isDirty: false,
  reset: vi.fn(),
  handleSubmit: vi.fn(),
  refetch: vi.fn(),
  setValues: vi.fn(),
}));

vi.mock("~/hooks/use-settings-form", () => ({
  useSettingsForm: () => formState,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  queryOptions: (options: unknown) => options,
}));
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle", proceed: vi.fn(), reset: vi.fn() }),
}));
vi.mock("~/lib/api-functions/settings", () => ({
  getBusinessSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  updateSeoSettings: vi.fn(),
}));
vi.mock("~/lib/api-query-options/settings", () => ({
  generalSettingsQueryOptions: () => ({
    queryKey: ["settings", "general"],
    queryFn: vi.fn(),
  }),
}));
// The outcome rail owns its own queries; this test is about the page draft.
vi.mock("./SeoDiscoveryStatusCard", () => ({
  SeoDiscoveryStatusCard: () => null,
}));

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

describe("SeoSettingsBuilder save bar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    formState.values = {
      siteTitle: "",
      homepageTitle: "",
      homepageMetaDescription: "",
      robotsTxt: "User-agent: *\nAllow: /",
      discovery: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS,
        returnPolicy: DEFAULT_SEO_RETURN_POLICY_SETTINGS,
      },
    };
    formState.isLoading = false;
    formState.isLoaded = true;
    formState.isLoadError = false;
    formState.isSaving = false;
    formState.isDirty = false;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function render() {
    act(() => {
      root.render(<SeoSettingsBuilder />);
    });
  }

  it("loads into a skeleton rather than a spinner", () => {
    formState.isLoading = true;
    render();

    expect(host.querySelector('[data-testid="skeleton-page"]')).not.toBeNull();
    expect(host.querySelector(".animate-spin")).toBeNull();
  });

  it("shows no save affordance while the draft is clean", () => {
    render();

    expect(host.querySelector('[data-testid="contextual-save-bar"]')).toBeNull();
    expect(findButton(host, "Save discovery settings")).toBeUndefined();
    expect(findButton(host, "Discard")).toBeUndefined();
    expect(findButton(host, "Reset")).toBeUndefined();
    // Every discovery authority still shares the one workspace.
    for (const section of [
      "Search appearance",
      "Sitemap",
      "Product catalog feed",
      "UCP catalog discovery",
      "robots.txt",
      "Structured data",
      "Return policy schema",
      "Advanced robots.txt rules",
    ]) {
      expect(host.textContent).toContain(section);
    }
  });

  it("saves and discards the whole page draft from one bar", () => {
    formState.isDirty = true;
    render();

    const bars = host.querySelectorAll('[data-testid="contextual-save-bar"]');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.getAttribute("role")).toBe("status");

    const save = findButton(host, "Save discovery settings");
    const discard = findButton(host, "Discard");
    expect(save).toBeDefined();
    expect(discard).toBeDefined();
    // The bar is the only save/discard pair on the page.
    expect(
      Array.from(host.querySelectorAll("button")).filter((button) =>
        /^(Save discovery settings|Saving|Discard|Reset)$/.test(
          button.textContent?.trim() ?? "",
        ),
      ),
    ).toHaveLength(2);

    act(() => {
      save?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(formState.handleSubmit).toHaveBeenCalledTimes(1);

    act(() => {
      discard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(formState.reset).toHaveBeenCalledTimes(1);
  });

  it("locks saving while the read failed but keeps the draft visible", () => {
    formState.isDirty = true;
    formState.isLoaded = false;
    render();

    const save = findButton(host, "Save discovery settings");
    expect(save?.disabled).toBe(true);
    expect(save?.getAttribute("title")).toBe(
      "Reload the SEO settings before saving.",
    );
  });
});
