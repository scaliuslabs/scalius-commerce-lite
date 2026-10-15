// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  STOREFRONT_SECTION_REGISTRY,
  storefrontSectionDefault,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontSectionType,
} from "@scalius/shared/storefront-theme";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { describeSetting, type SettingSpec } from "./introspect";
import { settingLabelKey, type LabelScope } from "./labels";
import { registryForms } from "./registry-forms";
import { useMediaPreviews } from "./resource-fields";
import { SchemaSettingsForm, settingFieldId } from "./SchemaSettingsForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminCollections: vi.fn(async () => ({ collections: [{ id: "col_eid", name: "Eid picks" }], pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async () => ({ collections: [{ id: "col_eid", name: "Eid picks" }] })),
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({ categories: [{ id: "cat_honey", name: "Honey", status: "published" }] })),
  getApiV1AdminDiscounts: vi.fn(async () => ({
    discounts: [{ id: "promo_eid", name: "Eid", title: null, status: "active", deletedAtEpochSeconds: null, endsAtEpochSeconds: Date.now() / 1000 + 86_400 }],
  })),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
}));
const files = vi.hoisted(() => ({ next: [] as Array<{ id: string; url: string; altText?: string }> }));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ trigger, onSelect }: { trigger: ReactNode; onSelect?: (file: unknown) => void }) => (
    <span onClickCapture={() => onSelect?.(files.next[0])}>{trigger}</span>
  ),
}));

let root: Root;
let container: HTMLDivElement;
const seen: { value: Record<string, unknown> } = { value: {} };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(spec: SettingSpec, initial: Record<string, unknown>, scope: LabelScope = ["s.test"], prefix = "form") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Form() {
    const [value, setValue] = useState(initial);
    const media = useMediaPreviews([]);
    seen.value = value;
    return <SchemaSettingsForm idPrefix={prefix} scope={scope} spec={spec} value={value} onChange={setValue} media={media} />;
  }
  act(() => root.render(<QueryClientProvider client={queryClient}><Form /></QueryClientProvider>));
}

const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`);
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === label)!;

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(trigger: HTMLElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim().startsWith(label));
  expect(option, label).toBeDefined();
  act(() => option!.click());
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const label = (scope: LabelScope, path: string) => {
  const key = settingLabelKey(scope, path);
  return key ? themeSettingMessages.en[key] : path;
};

describe("SchemaSettingsForm over the registry", () => {
  it("draws every section and block variant's settings with a labelled control for each setting", () => {
    for (const form of registryForms()) {
      const value = form.id.startsWith("section:")
        ? storefrontSectionDefault(form.id.slice("section:".length) as StorefrontSectionType, "probe").settings as Record<string, unknown>
        : { ...storefrontVariantSpec(form.id.split(":")[1] as StorefrontBlockSlot, form.id.split(":")[2]!).defaults };
      render(form.spec, value, form.scope, "probe");
      const spec = form.spec;
      const fields = spec.kind === "object" ? spec.fields : spec.kind === "variants" ? [{ key: spec.key, spec }] : [];
      for (const each of fields) {
        expect(container.textContent, `${form.id} ${each.key}`).toContain(label(form.scope, each.key));
      }
      // Every value control the form draws is labelled or named.
      for (const control of container.querySelectorAll<HTMLElement>("input, textarea, button[role=combobox], button[role=switch]")) {
        const id = control.id;
        const named = control.getAttribute("aria-label") || (id && container.querySelector(`label[for="${CSS.escape(id)}"]`))
          || control.closest("label, fieldset, [role=group]");
        expect(named, `${form.id} ${id || control.outerHTML.slice(0, 80)}`).toBeTruthy();
      }
      act(() => root.render(<></>));
    }
  });
});

/** One schema with every shape the registry uses (and the record-naming keys). */
const KITCHEN_SINK = z.object({
  title: z.string().trim().max(80),
  body: z.string().trim().max(2000),
  heading: z.string().trim().max(120).optional(),
  limit: z.number().int().min(4).max(24),
  columns: z.number().int().min(2).max(6),
  hoverImage: z.boolean(),
  style: z.enum(["grid", "rail"]),
  pageSize: z.union([z.literal(12), z.literal(24)]),
  phonePlacement: z.enum(["after-categories"]).optional(),
  tabs: z.array(z.enum(["home", "categories", "search", "cart"])).min(2).max(3),
  items: z.array(z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().max(1000) }).strict()).max(2),
  cta: z.object({ label: z.string().trim().min(1).max(40), href: z.string().max(300) }).strict().nullable(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("newest") }).strict(),
    z.object({ kind: z.literal("collection"), collectionId: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("category"), categoryId: z.string().min(1) }).strict(),
  ]),
  mediaId: z.string().nullable(),
  link: z.string().nullable(),
  categoryIds: z.array(z.string()).max(12),
  collectionIds: z.array(z.string()).max(8),
  promotionId: z.string().nullable().optional(),
}).strict();

const START = {
  title: "",
  body: "",
  limit: 12,
  columns: 4,
  hoverImage: false,
  style: "rail",
  pageSize: 24,
  tabs: ["home", "categories"],
  items: [],
  cta: null,
  source: { kind: "newest" },
  mediaId: null,
  link: null,
  categoryIds: [],
  collectionIds: [],
};

describe("SchemaSettingsForm controls", () => {
  const spec = describeSetting(KITCHEN_SINK);
  const id = (path: string) => settingFieldId("sink", path);

  it("draws text by length, numbers by range, switches and choices", () => {
    render(spec, START, ["s.product-grid"], "sink");
    expect(field(id("title"))?.tagName).toBe("INPUT");
    expect(field(id("body"))?.tagName).toBe("TEXTAREA");
    type(field(id("title"))!, "Best sellers");
    type(field<HTMLTextAreaElement>(id("body"))!, "Long copy");
    // An optional text is absent when cleared, never "".
    type(field(id("heading"))!, "Hi");
    expect(seen.value.heading).toBe("Hi");
    type(field(id("heading"))!, "");
    expect("heading" in seen.value).toBe(false);

    // A long range slides; a short one steps within its bounds.
    expect(field(id("limit"))?.getAttribute("type")).toBe("range");
    act(() => {
      const slider = field(id("limit"))!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, "20");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(seen.value.limit).toBe(20);
    act(() => button("More Columns").click());
    act(() => button("More Columns").click());
    act(() => button("More Columns").click());
    expect(seen.value.columns).toBe(6);
    expect(button("More Columns").disabled).toBe(true);
    act(() => button("Fewer Columns").click());
    expect(seen.value.columns).toBe(5);

    act(() => field<HTMLButtonElement>(id("hoverImage"))!.click());
    expect(seen.value.hoverImage).toBe(true);
    choose(field(id("style"))!, "grid");
    expect(seen.value.style).toBe("grid");
    choose(field(id("pageSize"))!, "12");
    expect(seen.value.pageSize).toBe(12);
    expect(seen.value).toMatchObject({ title: "Best sellers", body: "Long copy" });
  });

  it("offers an optional choice's unset option and clears it", () => {
    render(spec, START, ["s.hero"], "sink");
    choose(field(id("phonePlacement"))!, "After category tiles");
    expect(seen.value.phonePlacement).toBe("after-categories");
    choose(field(id("phonePlacement"))!, "Same order as desktop");
    expect("phonePlacement" in seen.value).toBe(false);
  });

  it("orders a list of choices within its length limits", () => {
    render(spec, START, ["b.mobileNav"], "sink");
    expect(button("Remove Home").disabled).toBe(true);
    choose(field(id("tabs"))!, "Cart");
    expect(seen.value.tabs).toEqual(["home", "categories", "cart"]);
    expect(field<HTMLButtonElement>(id("tabs"))!.disabled).toBe(true);
    act(() => button("Move Cart up").click());
    expect(seen.value.tabs).toEqual(["home", "cart", "categories"]);
    act(() => button("Remove Home").click());
    expect(seen.value.tabs).toEqual(["cart", "categories"]);
  });

  it("adds, moves and removes list groups up to their maximum", () => {
    render(spec, START, ["s.faq"], "sink");
    act(() => button("Add question").click());
    act(() => button("Add question").click());
    expect(button("Add question")).toBeUndefined();
    type(field(id("items.0.question"))!, "First?");
    type(field(id("items.1.question"))!, "Second?");
    expect(field(id("items.1.answer"))?.tagName).toBe("TEXTAREA");
    act(() => button("Move Question 2 up").click());
    expect(seen.value.items).toEqual([{ question: "Second?", answer: "" }, { question: "First?", answer: "" }]);
    act(() => button("Remove Question 1").click());
    expect(seen.value.items).toEqual([{ question: "First?", answer: "" }]);
  });

  it("turns a group that can be left out on and off", () => {
    render(spec, START, ["s.banner"], "sink");
    expect(field(id("cta.label"))).toBeNull();
    act(() => field<HTMLButtonElement>(id("cta"))!.click());
    expect(seen.value.cta).toEqual({ label: "", href: "" });
    type(field(id("cta.label"))!, "Shop");
    act(() => field<HTMLButtonElement>(id("cta"))!.click());
    expect(seen.value.cta).toBeNull();
  });

  it("switches variants and draws the chosen variant's own settings with record pickers", async () => {
    render(spec, START, ["s.product-rail"], "sink");
    choose(field(id("source"))!, "A collection");
    expect(seen.value.source).toEqual({ kind: "collection", collectionId: "" });
    // The variant picker's popover finishes closing before the next select opens.
    await settle();
    await act(async () => field<HTMLButtonElement>(id("source.collectionId"))!.click());
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((each) => each.textContent?.trim() === "Eid picks");
      expect(found).toBeDefined();
      return found!;
    });
    await act(async () => option.click());
    expect(seen.value.source).toEqual({ kind: "collection", collectionId: "col_eid" });
    choose(field(id("source"))!, "A category");
    expect(seen.value.source).toEqual({ kind: "category", categoryId: "" });
  });

  it("picks images from Files and canonical links by key", () => {
    render(spec, START, ["s.banner"], "sink");
    files.next = [{ id: "media_banner", url: "https://cdn.test/banner.jpg" }];
    act(() => [...field(id("mediaId"))!.querySelectorAll("button")].find((each) => each.textContent === "Select image")!.click());
    expect(seen.value.mediaId).toBe("media_banner");
    act(() => [...field(id("mediaId"))!.querySelectorAll("button")].find((each) => each.textContent === "Remove")!.click());
    expect(seen.value.mediaId).toBeNull();
    const link = field(id("link"))!;
    act(() => link.focus());
    type(link, "collections/eid");
    act(() => link.blur());
    expect(seen.value.link).toBe("/collections/eid");
    expect(container.querySelector(`[aria-label="Browse collections, categories, products and pages"]`)).not.toBeNull();
  });

  it("picks categories, collections and a running promotion", async () => {
    render(spec, START, ["s.deal-block"], "sink");
    await act(async () => field<HTMLButtonElement>(id("categoryIds"))!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toBe("Honey"));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(seen.value.categoryIds).toEqual(["cat_honey"]);
    await settle();
    await act(async () => field<HTMLButtonElement>(id("promotionId"))!.click());
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain("Eid"));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(seen.value.promotionId).toBe("promo_eid");
  });

  it("describes every registry section schema without falling back", () => {
    for (const type of Object.keys(STOREFRONT_SECTION_REGISTRY) as StorefrontSectionType[]) {
      expect(() => describeSetting(STOREFRONT_SECTION_REGISTRY[type].settings)).not.toThrow();
    }
    expect(() => describeSetting(z.object({ when: z.date() }))).toThrow(/Unsupported/);
  });
});
