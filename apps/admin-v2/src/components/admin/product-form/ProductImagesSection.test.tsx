// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm, type UseFormReturn } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Form } from "@/components/ui/form";
import { ProductImagesSection } from "./ProductImagesSection";
import type { ProductFormValues, ProductMediaItem } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// As loaded from a saved product: with no description anywhere, the storefront
// alt text falls back to the product title, which every photo shares.
function media(id: string, name: string, sortOrder: number, kind: "image" | "video" = "image"): ProductMediaItem {
  return {
    id, mediaId: `media_${id}`, kind, url: `https://cdn.example.test/${name}`, posterMediaId: null, posterUrl: null,
    effectiveAltText: "Cotton panjabi", altText: "", filename: name, caption: null, width: 10, height: 10, durationMs: null,
    isPrimary: sortOrder === 0, sortOrder, status: "ready",
  };
}

let form: UseFormReturn<ProductFormValues>;

function Harness({ readOnly = false }: { readOnly?: boolean }) {
  form = useForm<ProductFormValues>({
    defaultValues: { media: [media("a", "red.jpg", 0), media("b", "blue.jpg", 1), media("c", "demo.mp4", 2, "video")] } as ProductFormValues,
  });
  return <Form {...form}><ProductImagesSection form={form} readOnly={readOnly} /></Form>;
}

describe("ProductImagesSection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it("names every tile control after the item and its position", () => {
    expect(host.querySelector('article[aria-label="photo 2 of 3, blue.jpg"]')).not.toBeNull();
    expect([...host.querySelectorAll("article img")].map((image) => image.getAttribute("alt"))).toEqual(["red.jpg", "blue.jpg"]);
    expect(button("Move photo 2 of 3 earlier")).not.toBeNull();
    expect(button("Move photo 2 of 3 later")).not.toBeNull();
    expect(button("Edit the description of photo 2 of 3")).not.toBeNull();
    expect(button("Remove photo 2 of 3, blue.jpg")).not.toBeNull();
    expect(button("Make video 3 of 3 the main video")).not.toBeNull();
    expect(button("Make photo 1 of 3 the main photo")?.disabled).toBe(true);
  });

  it("makes a photo the main one and reorders without dragging", () => {
    act(() => button("Make photo 2 of 3 the main photo")!.click());
    expect(form.getValues("media").map((item) => item.isPrimary)).toEqual([false, true, false]);

    act(() => button("Move photo 2 of 3 earlier")!.click());
    expect(form.getValues("media").map((item) => item.filename)).toEqual(["blue.jpg", "red.jpg", "demo.mp4"]);
    expect(host.querySelector('article[aria-label="photo 1 of 3, blue.jpg"]')).not.toBeNull();
  });

  it("edits one item's description in a labelled field", () => {
    act(() => button("Edit the description of photo 2 of 3")!.click());
    const input = host.querySelector<HTMLInputElement>("input");
    const label = host.querySelector(`label[for="${input!.id}"]`);
    expect(label?.textContent).toBe("Description for photo 2 of 3");
    expect(input!.placeholder).toBe("Cotton panjabi");

    act(() => form.setValue("media", form.getValues("media").map((item, index) => index === 1 ? { ...item, altText: "Blue panjabi, front" } : item)));
    expect(host.querySelector('article[aria-label="photo 2 of 3, Blue panjabi, front"]')).not.toBeNull();
    expect(button("Remove photo 2 of 3, Blue panjabi, front")).not.toBeNull();
  });

  it("shows view-only staff the media with no edit or add controls", async () => {
    await act(async () => root.render(<Harness readOnly />));

    expect(host.querySelector('article[aria-label="photo 2 of 3, blue.jpg"]')).not.toBeNull();
    expect(host.querySelectorAll("article img")).toHaveLength(2);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.textContent).not.toContain("Add media");
  });
});
