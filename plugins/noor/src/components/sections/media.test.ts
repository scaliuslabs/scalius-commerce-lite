// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { fixtureContext, fixtureSectionSkinData, renderSection, renderSkin, storefrontShown } from "@scalius/plugin-sdk/storefront/testing";
import { resolveStorefrontSettings } from "@scalius/shared/plugins";
import { manifest } from "../../index";
import storefront from "../../storefront";

function render(type: string, values: Record<string, unknown>) {
  const parsed = parsePluginManifest(manifest);
  if (!parsed.ok) throw new Error("Invalid Noor manifest");
  const section = parsed.manifest.storefront.sections.find((entry) => entry.type === type)!;
  const settings = resolveStorefrontSettings(section.settings, values, {
    image: (id) => ({ url: `https://media.example/${id}.webp`, srcset: `https://media.example/${id}-600.webp 600w, https://media.example/${id}.webp 1200w`, width: 1200, height: 800, alt: id }),
    products: () => [],
  });
  const result = storefrontShown(renderSection(storefront, type, settings), "scalius.noor");
  expect(result.dropped).toBe(0);
  document.body.innerHTML = result.html;
  return document.body;
}

/** The store's hero with one slide, drawn by Noor's hero skin. */
function renderHero(slide: { image?: string; phoneImage?: string }, next?: { image: string }) {
  const photo = (id: string | undefined) => (id
    ? { url: `https://media.example/${id}.webp`, srcset: `https://media.example/${id}-600.webp 600w, https://media.example/${id}.webp 1200w`, width: 1200, height: 800, alt: id }
    : null);
  const skin = parsePluginManifest(manifest);
  if (!skin.ok) throw new Error("Invalid Noor manifest");
  const settings = resolveStorefrontSettings(skin.manifest.storefront.skins.find((entry) => entry.id === "noor_hero")!.settings, {}, { image: () => null, products: () => [] });
  const data = fixtureSectionSkinData("hero", { layout: "full-bleed", slides: [slide, ...(next ? [next] : [])].map((entry) => ({ image: photo(entry.image), phoneImage: photo("phoneImage" in entry ? entry.phoneImage : undefined), alt: "", focalPoint: { x: 50, y: 50 }, link: null })) });
  const result = storefrontShown(renderSkin(storefront, "noor_hero", "section:hero", settings, data), "scalius.noor");
  expect(result.dropped).toBe(0);
  document.body.innerHTML = result.html;
  return document.body;
}

afterEach(() => document.body.replaceChildren());

describe("Noor responsive media", () => {
  it.each([
    ["en", "Open gallery link"],
    ["bn", "গ্যালারির লিংক খুলুন"],
  ])("names gallery links with empty image alt in %s without replacing merchant descriptions", (language, label) => {
    const image = { url: "https://media.example/gallery.webp", srcset: null, width: 1200, height: 800, alt: "" };
    const context = fixtureContext();
    const result = storefrontShown(renderSection(storefront, "gallery", {
      eyebrow: null, heading: null, handle: null, link: null, tone: "plain", spacing: "m",
      images: [
        { image, link: "/products/linen" },
        { image: { ...image, alt: "Merchant's linen detail" }, link: "/products/linen" },
        { image, link: null },
      ],
    }, { context: { store: { ...context.store, language } } }), "scalius.noor");
    expect(result.dropped).toBe(0);
    document.body.innerHTML = result.html;
    const links = document.querySelectorAll(".noor-wall a");
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("aria-label")).toBe(label);
    expect(links[0]!.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(links[1]!.hasAttribute("aria-label")).toBe(false);
    expect(links[1]!.querySelector("img")!.getAttribute("alt")).toBe("Merchant's linen detail");
  });

  it("lets the browser select one crop instead of rendering two eager images", () => {
    const root = renderHero({ image: "wide", phoneImage: "phone" });
    expect(root.querySelectorAll("img")).toHaveLength(1);
    const source = root.querySelector("picture > source")!;
    expect(source.getAttribute("media")).toBe("(max-width: 47.99rem)");
    expect(source.getAttribute("srcset")).toContain("phone-600.webp 600w");
    expect(root.querySelector("picture > img")!.getAttribute("src")).toBe("https://media.example/wide.webp");
    expect(root.querySelector("img")!.getAttribute("loading")).toBe("eager");
  });

  it.each(["image", "phoneImage"])("keeps a sole %s visible at every screen width", (key) => {
    const root = renderHero({ [key]: "only" });
    expect(root.querySelector("source")).toBeNull();
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://media.example/only.webp");
    expect(root.querySelector("img")!.className).toBe("noor-hero-img");
  });

  it("only prioritizes the first hero-skin slideshow image and provides an explicit autoplay control", () => {
    const root = renderHero({ image: "first", phoneImage: "phone" }, { image: "second" });
    expect([...root.querySelectorAll("img")].map((image) => image.loading)).toEqual(["eager", "lazy"]);
    expect(root.querySelector("[data-autoplay-toggle]")!.getAttribute("aria-label")).toBe("Pause slideshow");
  });

  it("keeps the standalone slideshow's autoplay control", () => {
    const root = render("slideshow", { autoplay: true, slides: [{ image: "first" }, { image: "second" }] });
    expect(root.querySelector("[data-autoplay-toggle]")!.getAttribute("aria-label")).toBe("Pause slideshow");
  });

  it.each([false, true])("keeps video controls available before hydration (autoplay %s)", (autoplay) => {
    const root = render("video", { video_url: "https://media.example/film.mp4", autoplay });
    const video = root.querySelector("video")!;
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("autoplay")).toBe(false);
    expect(video.preload).toBe("none");
    expect(video.closest("scalius-island") !== null).toBe(autoplay);
  });
});
