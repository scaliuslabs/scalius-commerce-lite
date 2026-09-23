import type { MediaFile } from "~/components/admin/media-manager/types";
import type { getApiV1AdminSettingsHeroSlidersById } from "@scalius/api-client/sdk";
import type { ApiResult } from "~/lib/api";

export type { MediaFile };

export type HeroSlider = ApiResult<typeof getApiV1AdminSettingsHeroSlidersById>;
export type SliderImage = HeroSlider["images"][number];

/** Generate a unique image ID using crypto.randomUUID() */
export function generateImageId(): string {
  return `img_${crypto.randomUUID().replace(/-/g, "").substring(0, 20)}`;
}
