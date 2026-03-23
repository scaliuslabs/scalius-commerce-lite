import type { MediaFile } from "~/components/admin/media-manager/types";

export type { MediaFile };

export interface SliderImage {
  id: string;
  url: string;
  title: string;
  link: string;
}

export interface HeroSlider {
  id: string;
  type: "desktop" | "mobile";
  images: SliderImage[];
  isActive: boolean;
}

/** Generate a unique image ID using crypto.randomUUID() */
export function generateImageId(): string {
  return `img_${crypto.randomUUID().replace(/-/g, "").substring(0, 7)}`;
}
