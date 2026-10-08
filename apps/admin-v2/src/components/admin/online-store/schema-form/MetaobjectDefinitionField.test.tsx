// @vitest-environment happy-dom
/** The Content types section's form: the content type picker writes `definitionId`. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STOREFRONT_SECTION_REGISTRY, storefrontSectionDefault } from "@scalius/shared/storefront-theme";

const sdk = vi.hoisted(() => ({ getApiV1AdminMetaobjectsDefinitions: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

import { sectionLabelScope } from "./labels";
import { useMediaPreviews } from "./resource-fields";
import { sectionSettingSpec } from "./registry-forms";
import { SchemaSettingsForm } from "./SchemaSettingsForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamps = { createdAt: "", updatedAt: "" };
const type = (id: string, name: string, storefrontAccess: boolean) => ({
  id, handle: `custom.${id}`, namespace: "custom", type: id, name, description: null, fields: [], displayField: null,
  storefrontAccess, owner: "merchant" as const, entryCount: 1, revision: 1, ...stamps,
});
const envelope = <T,>(data: T) => Promise.resolve({ data: { success: true, data }, response: { status: 200 } });

let root: Root;
let container: HTMLDivElement;
const seen: { value: Record<string, unknown> } = { value: {} };

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function render(initial: Record<string, unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Form() {
    const [value, setValue] = useState(initial);
    const media = useMediaPreviews([]);
    seen.value = value;
    return (
      <SchemaSettingsForm idPrefix="section-metaobjects" scope={sectionLabelScope("metaobjects")} spec={sectionSettingSpec("metaobjects")} value={value} onChange={setValue} media={media} />
    );
  }
  await act(async () => root.render(<QueryClientProvider client={queryClient}><Form /></QueryClientProvider>));
  // The picker loads on first use.
  await vi.waitFor(() => expect(container.querySelector("button#section-metaobjects-definitionId")).not.toBeNull());
}

const defaults = () => storefrontSectionDefault("metaobjects", "probe").settings as Record<string, unknown>;

describe("Content types section form", () => {
  it("lists the content types the store may show and writes the chosen one as definitionId", async () => {
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [type("faq", "Questions and answers", true), type("secret", "Staff notes", false)] }));
    await render(defaults());
    await vi.waitFor(() => expect(sdk.getApiV1AdminMetaobjectsDefinitions).toHaveBeenCalled());
    await act(async () => container.querySelector<HTMLElement>("button#section-metaobjects-definitionId")!.click());
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    // A private type is not offered.
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining("Questions and answers")]);
    await act(async () => options[0]!.click());
    expect(seen.value.definitionId).toBe("faq");
    expect(STOREFRONT_SECTION_REGISTRY.metaobjects.settings.safeParse(seen.value).success).toBe(true);
  });

  it("draws the heading, layout and number of entries", async () => {
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [] }));
    await render(defaults());
    const text = container.textContent ?? "";
    expect(text).toContain("Heading");
    expect(text).toContain("Layout");
    expect(text).toContain("Entries shown");
    await act(async () => container.querySelector<HTMLElement>("button#section-metaobjects-layout")!.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(["List", "Cards", "Questions that open"]);
  });

  it("points to Content types when there is none to show", async () => {
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [type("secret", "Staff notes", false)] }));
    await render(defaults());
    await vi.waitFor(() => expect(container.textContent).toContain("No content type is shown on your store yet."));
    expect(container.querySelector('a[href="/admin/metaobjects"]')).not.toBeNull();
  });

  it("warns when the chosen content type is private, and when it is gone", async () => {
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [type("secret", "Staff notes", false)] }));
    await render({ ...defaults(), definitionId: "secret" });
    await vi.waitFor(() => expect(container.textContent).toContain("This content type is private"));
    expect(container.querySelector("button#section-metaobjects-definitionId")!.textContent).toContain("Staff notes");
    expect(container.querySelector('a[href="/admin/metaobjects"]')).not.toBeNull();
    await act(async () => root.render(<></>));
    sdk.getApiV1AdminMetaobjectsDefinitions.mockImplementation(() => envelope({ items: [] }));
    await render({ ...defaults(), definitionId: "removed" });
    await vi.waitFor(() => expect(container.textContent).toContain("no longer exists"));
  });
});
