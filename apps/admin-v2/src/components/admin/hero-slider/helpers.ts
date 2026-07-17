import type { MediaFile } from "~/components/admin/media-manager/types";
import type { HeroSlideFocalPoint } from "@scalius/shared/hero-slider";

export type { MediaFile };

export interface SliderImage {
  id: string;
  url: string;
  title: string;
  link: string;
  focalPoint: HeroSlideFocalPoint;
}

export interface HeroSlider {
  id: string;
  type: "desktop" | "mobile";
  images: SliderImage[];
  isActive: boolean;
  revision: number;
}

/** Generate a unique image ID using crypto.randomUUID() */
export function generateImageId(): string {
  return `img_${crypto.randomUUID().replace(/-/g, "").substring(0, 20)}`;
}
