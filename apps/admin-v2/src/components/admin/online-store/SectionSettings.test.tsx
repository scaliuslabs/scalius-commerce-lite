// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontSectionDefault, type StorefrontHeroSlide, type StorefrontPlatformSection, type StorefrontSectionType } from "@scalius/shared/storefront-theme";
import { BlockSettingsForm, HeroAddSlides, SectionSettingsForm, useSectionErrors } from "./SectionSettings";
import { addBlock } from "./theme-editor/editor-state";
import { useMediaPreviews } from "./schema-form/resource-fields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTIONS = [{ id: "col_eid", name: "Eid picks" }, { id: "col_new", name: "New in" }];
const CATEGORIES = [
  { id: "cat_honey", name: "Honey", status: "published" },
  { id: "cat_ghee", name: "Ghee", status: "published" },
  { id: "cat_draft", name: "Coming soon", status: "draft" },
];

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminCollections: vi.fn(async () => ({ collections: COLLECTIONS, pagination: { page: 1, totalPages: 1 } })),
  getApiV1AdminCollectionsByIds: vi.fn(async ({ query }: { query: { ids: string } }) => ({
    collections: COLLECTIONS.filter((collection) => query.ids.split(",").includes(collection.id)),
  })),
  getApiV1AdminCategoriesFormOptions: vi.fn(async () => ({ categories: CATEGORIES })),
  getApiV1AdminDiscounts: vi.fn(async () => ({ discounts: [] })),
}));
const files = vi.hoisted(() => ({ next: [] as Array<{ id: string; url: string; altText?: string }> }));
vi.mock("~/components/admin/media-manager", () => ({
  MediaManager: ({ trigger, onSelect, onSelectMultiple }: {
    trigger: ReactNode;
    onSelect?: (file: unknown) => void;
    onSelectMultiple?: (files: unknown[]) => void;
  }) => (
    <span onClickCapture={() => (onSelectMultiple ? onSelectMultiple(files.next) : onSelect?.(files.next[0]))}>{trigger}</span>
  ),
}));
vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
const seen: { section: StorefrontPlatformSection | null } = { section: null };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontPlatformSection;

/** The section's own form, or one block of it (`slides`, 0) as the editor opens it; with `addSlides`, the hero's "Add slides" too. */
function render(initial: StorefrontPlatformSection, block?: { path: string; index: number }, addSlides = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Form() {
    const [current, setCurrent] = useState(initial);
    const media = useMediaPreviews([]);
    const errors = useSectionErrors(current);
    seen.section = current;
    const onChange = (settings: StorefrontPlatformSection["settings"]) => setCurrent((each) => ({ ...each, settings }) as StorefrontPlatformSection);
    const slides = (current.settings as { slides?: StorefrontHeroSlide[] }).slides ?? [];
    return (
      <>
        {block
          ? <BlockSettingsForm section={current} path={block.path} index={block.index} media={media} errors={errors} onChange={onChange} />
          : <SectionSettingsForm section={current} media={media} errors={errors} onChange={onChange} />}
        {addSlides ? (
          <HeroAddSlides slides={slides} media={media} onChange={(next) => onChange({ ...current.settings, slides: next } as StorefrontPlatformSection["settings"])} />
        ) : null}
      </>
    );
  }
  act(() => root.render(<QueryClientProvider client={queryClient}><Form /></QueryClientProvider>));
}

const settings = () => seen.section!.settings;
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent?.trim() === label)!;
const field = <Element extends HTMLElement = HTMLInputElement>(id: string) => document.querySelector<Element>(`#${CSS.escape(id)}`)!;
const note = (id: string) => document.querySelector(`#${CSS.escape(id)}-note`)?.textContent;

function choose(trigger: HTMLButtonElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim().startsWith(label));
  expect(option).toBeDefined();
  act(() => option!.click());
}

async function chooseLoaded(trigger: HTMLButtonElement, label: string) {
  await act(async () => trigger.click());
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((item) => item.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  });
  await act(async () => option.click());
}

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function typeAndLeave(input: HTMLInputElement, value: string) {
  act(() => input.focus());
  type(input, value);
  act(() => input.blur());
}

describe("section settings (generated from the registry)", () => {
  it("picks collections in order with a carousel style", async () => {
    render(section("collections", "collections"));
    await chooseLoaded(field<HTMLButtonElement>("theme-section-collections-collectionIds"), "New in");
    await chooseLoaded(field<HTMLButtonElement>("theme-section-collections-collectionIds"), "Eid picks");
    choose(field<HTMLButtonElement>("theme-section-collections-carousel"), "Compact shelf");
    act(() => button("Move Eid picks up").click());
    expect(settings()).toEqual({ carousel: "compact", collectionIds: ["col_eid", "col_new"] });
  });

  it("names a collection that no longer exists, and removes it", async () => {
    render(section("collections", "collections", { collectionIds: ["col_gone", "col_eid"] }));
    await vi.waitFor(() => expect(container.textContent).toContain("Unavailable collection"));
    expect(container.textContent).toContain("Eid picks");
    act(() => button("Remove Unavailable collection").click());
    expect(settings()).toEqual({ carousel: "large", collectionIds: ["col_eid"] });
  });

  it("sets the category tiles' style, title and published categories in order", async () => {
    render(section("category-tiles", "tiles", { categoryIds: ["cat_gone"] }));
    choose(field<HTMLButtonElement>("theme-section-tiles-style"), "Square photo grid");
    expect(container.textContent).toContain("This style needs at least 2.");
    type(field("theme-section-tiles-title"), "Shop the pantry");
    await vi.waitFor(() => expect(container.textContent).toContain("Unavailable category"));
    // Only published categories are offered.
    act(() => field<HTMLButtonElement>("theme-section-tiles-categoryIds").click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim())).toEqual(["Honey", "Ghee"]);
    act(() => field<HTMLButtonElement>("theme-section-tiles-categoryIds").click());
    choose(field<HTMLButtonElement>("theme-section-tiles-categoryIds"), "Honey");
    choose(field<HTMLButtonElement>("theme-section-tiles-categoryIds"), "Ghee");
    act(() => button("Move Ghee up").click());
    act(() => button("Remove Unavailable category").click());
    expect(settings()).toEqual({ style: "square", title: "Shop the pantry", categoryIds: ["cat_ghee", "cat_honey"] });
  });

  it("adds hero slides from Files several at once, each with its alt text and a centred focus point", () => {
    render(section("hero", "hero"), undefined, true);
    // The slides are blocks: the section's own form never lists them.
    expect(container.textContent).not.toContain("Slide 1");
    files.next = [
      { id: "media_honey", url: "https://cdn.test/honey.jpg", altText: "Honey jars" },
      { id: "media_ghee", url: "https://cdn.test/ghee.jpg", altText: "" },
    ];
    act(() => button("Add slides").click());
    expect(settings()).toEqual({
      layout: "full-bleed",
      slides: [
        { image: "media_honey", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: null },
        { image: "media_ghee", focalPoint: { x: 50, y: 50 }, alt: "", link: null },
      ],
    });
  });

  it("edits one slide as a block: phone image, words and a canonical link", () => {
    render(section("hero", "hero", { slides: [{ image: "media_honey", focalPoint: { x: 50, y: 50 }, alt: "Honey jars", link: null }] }), { path: "slides", index: 0 });
    expect(field("theme-section-hero-slides-0-alt").value).toBe("Honey jars");
    files.next = [{ id: "media_honey_phone", url: "https://cdn.test/honey-phone.jpg" }];
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#theme-section-hero-slides-0-phone-image button")]
      .find((each) => each.textContent === "Select image")!.click());
    expect(document.querySelector<HTMLImageElement>("#theme-section-hero-slides-0-phone-image img")?.getAttribute("src")).toContain("honey-phone.jpg");

    // The button label waits for a link; a typed path settles into its canonical form.
    expect(document.querySelector("#theme-section-hero-slides-0-button")).toBeNull();
    typeAndLeave(field("theme-section-hero-slides-0-link"), "collections/eid");
    expect(field("theme-section-hero-slides-0-link").value).toBe("/collections/eid");
    type(field("theme-section-hero-slides-0-button"), "Shop Eid");
    type(field("theme-section-hero-slides-0-heading"), "Eid sale");
    expect(settings()).toEqual({
      layout: "full-bleed",
      slides: [{
        image: "media_honey",
        phoneImage: "media_honey_phone",
        focalPoint: { x: 50, y: 50 },
        phoneFocalPoint: { x: 50, y: 50 },
        alt: "Honey jars",
        heading: "Eid sale",
        buttonLabel: "Shop Eid",
        link: "/collections/eid",
      }],
    });
  });

  it("marks a slide's link that is no link, and missing alt text", () => {
    render(section("hero", "hero", { slides: [{ image: "media_ghee", focalPoint: { x: 50, y: 50 }, alt: "", link: null }] }), { path: "slides", index: 0 });
    typeAndLeave(field("theme-section-hero-slides-0-link"), "sale page");
    expect(note("theme-section-hero-slides-0-link")).toBe("Use a store path like /sale or a full https:// link.");
    expect(note("theme-section-hero-slides-0-alt")).toBe("Fill this in.");
  });

  it("removes a slide's phone image and its focus point", () => {
    const slide = { image: "m-1", phoneImage: "m-2", focalPoint: { x: 50, y: 50 }, phoneFocalPoint: { x: 20, y: 80 }, alt: "Bags", link: null };
    render(section("hero", "hero", { slides: [slide] }), { path: "slides", index: 0 });
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#theme-section-hero-slides-0-phone-image button")]
      .find((each) => each.textContent === "Remove")!.click());
    expect(settings()).toEqual({ layout: "full-bleed", slides: [{ image: "m-1", focalPoint: { x: 50, y: 50 }, alt: "Bags", link: null }] });
  });

  it("sets the banner layout and its phone placement", () => {
    render(section("hero", "hero", { layout: "split" }));
    expect(document.querySelector("#theme-section-hero-phoneHeight")).toBeNull();
    choose(field<HTMLButtonElement>("theme-section-hero-layout"), "Full screen banner");
    // Leaving the phone height unset is most of the first screen (70%).
    expect(field<HTMLButtonElement>("theme-section-hero-phoneHeight").textContent).toContain("Most of the first screen");
    choose(field<HTMLButtonElement>("theme-section-hero-phonePlacement"), "After category tiles");
    expect(settings()).toEqual({ layout: "full-screen", slides: [], phonePlacement: "after-categories" });
    choose(field<HTMLButtonElement>("theme-section-hero-phonePlacement"), "Same order as desktop");
    expect(settings()).toEqual({ layout: "full-screen", slides: [] });
    // Side promotions are blocks of the contained layout, never fields of the section's form.
    choose(field<HTMLButtonElement>("theme-section-hero-layout"), "Contained banner with side promos");
    expect(container.textContent).not.toContain("Add side promotion");
  });

  it("edits a side promotion as a block", () => {
    const hero = addBlock(section("hero", "hero", { layout: "contained-banners", sideBanners: [] }), "sideBanners") as StorefrontPlatformSection;
    render(hero, { path: "sideBanners", index: 0 });
    files.next = [{ id: "m-side", url: "https://cdn.test/side.jpg", altText: "" }];
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#theme-section-hero-sideBanners-0-mediaId button")]
      .find((each) => each.textContent === "Select image")!.click());
    type(field("theme-section-hero-sideBanners-0-alt"), "Fresh honey jars");
    typeAndLeave(field("theme-section-hero-sideBanners-0-href"), "/collections/honey");
    expect(settings()).toEqual({
      layout: "contained-banners",
      slides: [],
      sideBanners: [{ mediaId: "m-side", alt: "Fresh honey jars", href: "/collections/honey" }],
    });
  });

  it("switches an editorial layout keeping the words both layouts carry", () => {
    render(section("editorial", "feature", { layout: "image-with-text", heading: "", body: "", mediaId: null, imageSide: "end" }));
    type(field("theme-section-feature-heading"), "Our honey story");
    type(field<HTMLTextAreaElement>("theme-section-feature-body"), "Collected in the Sundarbans.");
    choose(field<HTMLButtonElement>("theme-section-feature-imageSide"), "Before text");
    expect(settings()).toEqual({ layout: "image-with-text", heading: "Our honey story", body: "Collected in the Sundarbans.", mediaId: null, imageSide: "start" });
    choose(field<HTMLButtonElement>("theme-section-feature-layout"), "Text");
    expect(settings()).toEqual({ layout: "rich-text", heading: "Our honey story", body: "Collected in the Sundarbans." });
    choose(field<HTMLButtonElement>("theme-section-feature-layout"), "Columns");
    expect(settings()).toEqual({ layout: "multicolumn", heading: "Our honey story", columns: [] });
    // Columns are blocks.
    expect(container.textContent).not.toContain("Add column");
  });

  it("edits an editorial column as a block", () => {
    const base = { ...section("editorial", "feature"), settings: { layout: "multicolumn", heading: "", columns: [] } } as StorefrontPlatformSection;
    const columns = addBlock(base, "columns") as StorefrontPlatformSection;
    render(columns, { path: "columns", index: 0 });
    type(field("theme-section-feature-columns-0-title"), "Raw honey");
    type(field<HTMLTextAreaElement>("theme-section-feature-columns-0-text"), "From the forest.");
    expect(settings()).toEqual({ layout: "multicolumn", heading: "", columns: [{ title: "Raw honey", text: "From the forest." }] });
  });

  it("edits a question and its answer as a block", () => {
    render(addBlock(section("faq", "faq"), "items") as StorefrontPlatformSection, { path: "items", index: 0 });
    type(field("theme-section-faq-items-0-question"), "Where is it collected?");
    type(field<HTMLTextAreaElement>("theme-section-faq-items-0-answer"), "In the Sundarbans.");
    expect(settings()).toEqual({ heading: "", items: [{ question: "Where is it collected?", answer: "In the Sundarbans." }] });
  });

  it("says why a card without a name or with a bad link cannot be saved", () => {
    render(addBlock(section("shop-by", "cards"), "cards") as StorefrontPlatformSection, { path: "cards", index: 0 });
    typeAndLeave(field("theme-section-cards-cards-0-href"), "sale page");
    expect(note("theme-section-cards-cards-0-href")).toBe("Use a store path like /sale or a full https:// link.");
    expect(note("theme-section-cards-cards-0-title")).toBe("Fill this in.");
  });
});
