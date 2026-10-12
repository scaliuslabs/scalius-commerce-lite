// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { parsePluginManifest } from "@scalius/plugin-sdk/manifest";
import { renderSection } from "@scalius/plugin-sdk/storefront/testing";
import { resolveStorefrontSettings } from "@scalius/shared/plugins";
import { sanitizeStorefrontHtml } from "@scalius/shared/plugins/storefront-html";
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
  const result = sanitizeStorefrontHtml(renderSection(storefront, type, settings));
  expect(result.dropped).toBe(0);
  document.body.innerHTML = result.html;
  return document.body;
}

afterEach(() => document.body.replaceChildren());

describe("Noor responsive media", () => {
  it("lets the browser select one crop instead of rendering two eager images", () => {
    const root = render("hero", { image: "wide", phone_image: "phone" });
    expect(root.querySelectorAll("img")).toHaveLength(1);
    const source = root.querySelector("picture > source")!;
    expect(source.getAttribute("media")).toBe("(max-width: 47.99rem)");
    expect(source.getAttribute("srcset")).toContain("phone-600.webp 600w");
    expect(root.querySelector("picture > img")!.getAttribute("src")).toBe("https://media.example/wide.webp");
    expect(root.querySelector("img")!.getAttribute("loading")).toBe("eager");
  });

  it.each(["image", "phone_image"])("keeps a sole %s visible at every screen width", (key) => {
    const root = render("hero", { [key]: "only" });
    expect(root.querySelector("source")).toBeNull();
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://media.example/only.webp");
    expect(root.querySelector("img")!.className).toBe("noor-hero-img");
  });

  it("only prioritizes the first slideshow image and provides an explicit autoplay control", () => {
    const root = render("slideshow", { autoplay: true, slides: [{ image: "first", phone_image: "phone" }, { image: "second" }] });
    expect([...root.querySelectorAll("img")].map((image) => image.loading)).toEqual(["eager", "lazy"]);
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
