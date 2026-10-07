/**
 * Image previews and list helpers the theme forms share. Kept apart from the
 * resource fields so the theme editor's first render can hold the draft's
 * images without loading the settings forms.
 */
import { useState } from "react";
import type { MediaFile } from "~/components/admin/media-manager";

/** An image the theme forms can preview: the draft's images (the workspace's `media`) plus this session's picks. */
export interface SectionMediaPreview {
  id: string;
  url: string;
  alt: string;
}

export const mediaPreview = (file: MediaFile): SectionMediaPreview => ({ id: file.id, url: file.url, alt: file.altText?.trim() ?? "" });

/** Previews by media id: the given images, then any picked from Files in this session. */
export function useMediaPreviews(media: readonly SectionMediaPreview[]) {
  const [picked, setPicked] = useState<ReadonlyMap<string, SectionMediaPreview>>(new Map());
  return {
    previews: new Map([...media.map((each) => [each.id, each] as const), ...picked]) as ReadonlyMap<string, SectionMediaPreview>,
    remember: (image: SectionMediaPreview) => setPicked((current) => new Map(current).set(image.id, image)),
  };
}

export type MediaPreviews = ReturnType<typeof useMediaPreviews>;

/** The list with the item at `index` moved one place up (-1) or down (+1); unchanged at either end. */
export const moveAt = <Item,>(items: readonly Item[], index: number, delta: -1 | 1): Item[] => {
  const next = [...items];
  const to = index + delta;
  if (to < 0 || to >= next.length) return next;
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
};
export const removeAt = <Item,>(items: readonly Item[], index: number): Item[] => items.filter((_, at) => at !== index);
export const replaceAt = <Item,>(items: readonly Item[], index: number, item: Item): Item[] =>
  items.map((each, at) => (at === index ? item : each));
