// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontSectionDefault, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { SectionEditor, newSectionId, sectionErrors } from "./SectionEditor";

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
/** The files the next pick from Files returns (several for a multi-select picker). */
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

let root: Root;
let container: HTMLDivElement;
const seen: { sections: StorefrontSection[] } = { sections: [] };

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const section = (type: StorefrontSection["type"], id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

function render(initial: StorefrontSection[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Page() {
    const [sections, setSections] = useState(initial);
    seen.sections = sections;
    return <SectionEditor sections={sections} notes={{}} media={[]} onChange={setSections} />;
  }
  act(() => root.render(<QueryClientProvider client={queryClient}><Page /></QueryClientProvider>));
}

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  ?? [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) => each.textContent === label)!;
const rows = () => [...container.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent);
const dialog = () => document.querySelector("[role=dialog]");

function choose(trigger: HTMLButtonElement, label: string) {
  act(() => trigger.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((item) => item.textContent?.trim() === label);
  expect(option).toBeDefined();
  act(() => option!.click());
}

/** Picks an option a select loads (from the server, or a query still loading). */
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

/** Types into a field, then leaves it (links settle into their canonical form on leaving). */
function typeAndLeave(input: HTMLInputElement, value: string) {
  act(() => input.focus());
  type(input, value);
  act(() => input.blur());
}

const note = (id: string) => document.querySelector(`#${CSS.escape(id)}-note`)?.textContent;

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function typeArea(input: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("homepage section editor", () => {
  it("flags sections with nothing to show", () => {
    render([section("shop-by", "cards"), section("product-rail", "rail")]);
    expect(rows()).toEqual(["Shop-by cardsHidden until you add its content.", "Product row"]);
  });

  it("adds a section with its settings on Done, under a free id", async () => {
    render([section("product-tabs", "product-tabs")]);
    choose(container.querySelector<HTMLButtonElement>('button[aria-label="Add section"]')!, "Product tabs");
    expect(dialog()?.textContent).toContain("Product tabs");
    expect(seen.sections).toHaveLength(1); // nothing lands before Done
    await act(async () => button("Done").click());
    expect(seen.sections.map((each) => each.id)).toEqual(["product-tabs", "product-tabs-2"]);
  });

  it("adds a collections section with its collections, in order, on Done", async () => {
    render([]);
    choose(container.querySelector<HTMLButtonElement>('button[aria-label="Add section"]')!, "Collections");
    expect(dialog()?.textContent).toContain("Collections");
    expect(seen.sections).toHaveLength(0);
    // The section picker's popover finishes closing before the dialog's own selects open.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await chooseLoaded(document.querySelector<HTMLButtonElement>("#section-collections-collections")!, "New in");
    await chooseLoaded(document.querySelector<HTMLButtonElement>("#section-collections-collections")!, "Eid picks");
    choose(document.querySelector<HTMLButtonElement>("#section-collections-carousel")!, "Compact shelf");
    act(() => button("Move Eid picks up").click());
    await act(async () => button("Done").click());
    expect(seen.sections).toEqual([{
      id: "collections",
      type: "collections",
      version: 1,
      settings: { carousel: "compact", collectionIds: ["col_eid", "col_new"] },
    }]);
  });

  it("names a collection that no longer exists, and removes it", async () => {
    render([section("collections", "collections", { collectionIds: ["col_gone", "col_eid"] })]);
    act(() => button("Edit Collections").click());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Unavailable collection"));
    expect(dialog()?.textContent).toContain("Eid picks");
    act(() => button("Remove Unavailable collection").click());
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ carousel: "large", collectionIds: ["col_eid"] });
  });

  it("saves the category tiles' style, title and published categories in order", async () => {
    render([section("category-tiles", "tiles", { categoryIds: ["cat_gone"] })]);
    act(() => button("Edit Featured categories").click());
    choose(document.querySelector<HTMLButtonElement>("#section-tiles-style")!, "Square photo grid");
    expect(dialog()?.textContent).toContain("This style needs at least 2.");
    type(document.querySelector<HTMLInputElement>("#section-tiles-title")!, "Shop the pantry");
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Unavailable category"));
    // Only published categories are offered.
    act(() => document.querySelector<HTMLButtonElement>("#section-tiles-categories")!.click());
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent?.trim())).toEqual(["Honey", "Ghee"]);
    act(() => document.querySelector<HTMLButtonElement>("#section-tiles-categories")!.click());
    choose(document.querySelector<HTMLButtonElement>("#section-tiles-categories")!, "Honey");
    choose(document.querySelector<HTMLButtonElement>("#section-tiles-categories")!, "Ghee");
    act(() => button("Move Ghee up").click());
    act(() => button("Remove Unavailable category").click());
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ style: "square", title: "Shop the pantry", categoryIds: ["cat_ghee", "cat_honey"] });
  });

  it("adds hero slides from Files with a phone image, alt text, words and a canonical link", async () => {
    render([section("hero", "hero")]);
    expect(rows()).toEqual(["BannersHidden until you add its content."]);
    act(() => button("Edit Banners").click());
    files.next = [
      { id: "media_honey", url: "https://cdn.test/honey.jpg", altText: "Honey jars" },
      { id: "media_ghee", url: "https://cdn.test/ghee.jpg", altText: "" },
    ];
    act(() => button("Add slides").click());
    expect(dialog()?.textContent).toContain("Slide 1");
    expect(dialog()?.textContent).toContain("Slide 2");
    expect(document.querySelector<HTMLInputElement>("#section-hero-slide-0-alt")!.value).toBe("Honey jars");
    expect(document.querySelector<HTMLImageElement>("#section-hero-slide-0-image img")?.getAttribute("src")).toContain("honey.jpg");

    files.next = [{ id: "media_honey_phone", url: "https://cdn.test/honey-phone.jpg" }];
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#section-hero-slide-0-phone-image button")]
      .find((each) => each.textContent === "Select image")!.click());
    expect(document.querySelector<HTMLImageElement>("#section-hero-slide-0-phone-image img")?.getAttribute("src")).toContain("honey-phone.jpg");

    // The button label waits for a link; a typed path settles into its canonical form.
    expect(document.querySelector("#section-hero-slide-0-button")).toBeNull();
    typeAndLeave(document.querySelector<HTMLInputElement>("#section-hero-slide-0-link")!, "collections/eid");
    expect(document.querySelector<HTMLInputElement>("#section-hero-slide-0-link")!.value).toBe("/collections/eid");
    type(document.querySelector<HTMLInputElement>("#section-hero-slide-0-button")!, "Shop Eid");
    type(document.querySelector<HTMLInputElement>("#section-hero-slide-0-heading")!, "Eid sale");

    // Text that is no link is marked when left, and alt text is required.
    typeAndLeave(document.querySelector<HTMLInputElement>("#section-hero-slide-1-link")!, "sale page");
    expect(note("section-hero-slide-1-link")).toBe("Use a store path like /sale or a full https:// link.");
    await act(async () => button("Done").click());
    expect(dialog()?.textContent).toContain("Fix the marked fields first.");
    expect(note("section-hero-slide-1-alt")).toBe("Fill this in.");
    expect(seen.sections[0]?.settings).toEqual({ layout: "full-bleed", slides: [] });

    type(document.querySelector<HTMLInputElement>("#section-hero-slide-1-alt")!, "Ghee tins");
    typeAndLeave(document.querySelector<HTMLInputElement>("#section-hero-slide-1-link")!, "");
    act(() => button("Move Slide 2 up").click());
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({
      layout: "full-bleed",
      slides: [
        { image: "media_ghee", focalPoint: { x: 50, y: 50 }, alt: "Ghee tins", link: null },
        {
          image: "media_honey",
          phoneImage: "media_honey_phone",
          focalPoint: { x: 50, y: 50 },
          phoneFocalPoint: { x: 50, y: 50 },
          alt: "Honey jars",
          heading: "Eid sale",
          buttonLabel: "Shop Eid",
          link: "/collections/eid",
        },
      ],
    });
    expect(rows()).toEqual(["Banners"]);
  });

  it("removes a slide's phone image and its focus point", async () => {
    const slide = { image: "m-1", phoneImage: "m-2", focalPoint: { x: 50, y: 50 }, phoneFocalPoint: { x: 20, y: 80 }, alt: "Bags", link: null };
    render([section("hero", "hero", { slides: [slide] })]);
    act(() => button("Edit Banners").click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>("#section-hero-slide-0-phone-image button")]
      .find((each) => each.textContent === "Remove")!.click());
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ layout: "full-bleed", slides: [{ image: "m-1", focalPoint: { x: 50, y: 50 }, alt: "Bags", link: null }] });
  });

  it("edits the homepage banner layout and restores a removed banner section", async () => {
    render([section("hero", "hero", { layout: "story-cards" })]);
    act(() => button("Edit Banners").click());
    choose(document.querySelector<HTMLButtonElement>("#section-hero-layout")!, "Wide editorial banner");
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ layout: "wide-editorial", slides: [] });
    act(() => button("Remove Banners").click());
    choose(container.querySelector<HTMLButtonElement>('button[aria-label="Add section"]')!, "Banners");
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.type).toBe("hero");
  });

  it("saves a different phone banner position without changing the desktop section order", async () => {
    render([section("hero", "hero"), section("category-tiles", "tiles")]);
    act(() => button("Edit Banners").click());
    choose(document.querySelector<HTMLButtonElement>("#section-hero-phone-placement")!, "After category tiles");
    await act(async () => button("Done").click());
    expect(seen.sections.map((each) => each.id)).toEqual(["hero", "tiles"]);
    expect(seen.sections[0]?.settings).toEqual({ layout: "full-bleed", slides: [], phonePlacement: "after-categories" });
  });

  it("saves side promotion copy and link with a contained banner", async () => {
    render([section("hero", "hero", { layout: "contained-banners", sideBanners: [{ mediaId: "m-1", alt: "Honey jars", href: null }] })]);
    act(() => button("Edit Banners").click());
    type(document.querySelector<HTMLInputElement>("#section-hero-side-banner-0-alt")!, "Fresh honey jars");
    type(document.querySelector<HTMLInputElement>("#section-hero-side-banner-0-link")!, "/collections/honey");
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({
      layout: "contained-banners",
      slides: [],
      sideBanners: [{ mediaId: "m-1", alt: "Fresh honey jars", href: "/collections/honey" }],
    });
  });

  it("lets a merchant fill the showcase story and questions that start hidden", async () => {
    render([
      section("editorial", "feature", { layout: "image-with-text", heading: "", body: "", mediaId: null, imageSide: "end" }),
      section("faq", "faq"),
    ]);
    expect(rows()).toEqual([
      "Image with textHidden until you add its content.",
      "Questions and answersHidden until you add its content.",
    ]);
    act(() => button("Edit Image with text").click());
    type(document.querySelector<HTMLInputElement>("#section-feature-heading")!, "Our honey story");
    typeArea(document.querySelector<HTMLTextAreaElement>("#section-feature-body")!, "Collected in the Sundarbans.");
    choose(document.querySelector<HTMLButtonElement>("#section-feature-image-side")!, "Before text");
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ layout: "image-with-text", heading: "Our honey story", body: "Collected in the Sundarbans.", mediaId: null, imageSide: "start" });

    act(() => button("Edit Questions and answers").click());
    act(() => button("Add question").click());
    type(document.querySelector<HTMLInputElement>("#section-faq-question-0")!, "Where is it collected?");
    typeArea(document.querySelector<HTMLTextAreaElement>("#section-faq-question-0-answer")!, "In the Sundarbans.");
    await act(async () => button("Done").click());
    expect(seen.sections[1]?.settings).toEqual({ heading: "", items: [{ question: "Where is it collected?", answer: "In the Sundarbans." }] });
    expect(rows()).toEqual(["Our honey story", "Questions and answers"]);
  });

  it("edits the showcase highlights and customer quotes", async () => {
    render([
      { id: "highlights", type: "editorial", version: 1, settings: { layout: "multicolumn", heading: "", columns: [] } },
      { id: "testimonials", type: "editorial", version: 1, settings: { layout: "testimonial", quotes: [] } },
    ]);
    expect(rows()).toEqual(["ColumnsHidden until you add its content.", "Customer quotesHidden until you add its content."]);
    act(() => button("Edit Columns").click());
    act(() => button("Add column").click());
    type(document.querySelector<HTMLInputElement>("#section-highlights-column-0-title")!, "Raw honey");
    typeArea(document.querySelector<HTMLTextAreaElement>("#section-highlights-column-0-text")!, "From the forest.");
    await act(async () => button("Done").click());
    expect(seen.sections[0]?.settings).toEqual({ layout: "multicolumn", heading: "", columns: [{ title: "Raw honey", text: "From the forest." }] });

    act(() => button("Edit Customer quotes").click());
    act(() => button("Add quote").click());
    typeArea(document.querySelector<HTMLTextAreaElement>("#section-testimonials-quote-0")!, "Lovely honey.");
    await act(async () => button("Done").click());
    expect(seen.sections[1]?.settings).toEqual({ layout: "testimonial", quotes: [{ quote: "Lovely honey.", author: "" }] });
  });

  it("keeps a card without a name or with a bad link out of the draft and says why", async () => {
    render([section("shop-by", "cards")]);
    act(() => button("Edit Shop-by cards").click());
    act(() => button("Add card").click());
    type(document.querySelector<HTMLInputElement>("#section-cards-card-0-link")!, "sale");
    await act(async () => button("Done").click());
    expect(dialog()?.textContent).toContain("Fix the marked fields first.");
    expect(dialog()?.textContent).toContain("Use a store path like /sale or a full https:// link.");
    expect(dialog()?.textContent).toContain("Fill this in.");
    expect(seen.sections[0]).toEqual(section("shop-by", "cards"));
  });

  it("removes a section", () => {
    render([section("brand-wall", "brands"), section("recently-viewed", "recent")]);
    act(() => button("Remove Brands").click());
    expect(seen.sections.map((each) => each.id)).toEqual(["recent"]);
  });

  it("names new ids after their type and maps errors to their fields", () => {
    expect(newSectionId("shop-by", [section("shop-by", "shop-by"), section("shop-by", "shop-by-2")])).toBe("shop-by-3");
    const errors = sectionErrors(section("banner-mosaic", "m", { tiles: [{ mediaId: "", alt: "", href: "//evil" }] }));
    expect(errors.get("tiles.0.mediaId")?.key).toBe("fieldRequired");
    expect(errors.get("tiles.0.href")?.key).toBe("linkInvalid");
    const tabs = sectionErrors(section("product-tabs", "t", { tabs: [{ label: "", source: { kind: "newest" } }] }));
    expect(tabs.get("tabs")).toEqual({ key: "fieldCount", values: { count: 2 } });
  });
});
