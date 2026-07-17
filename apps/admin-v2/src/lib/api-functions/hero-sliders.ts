import { createServerFn } from "@tanstack/react-start";
import type { HeroSlideFocalPoint } from "@scalius/shared/hero-slider";
import { apiGet, apiPost, apiPut } from "../api.server";

export type HeroSliderType = "desktop" | "mobile";

export interface SliderImage {
  id: string;
  url: string;
  title: string;
  link: string;
  focalPoint: HeroSlideFocalPoint;
}

export interface HeroSliderRecord {
  id: string;
  type: HeroSliderType;
  images: SliderImage[];
  isActive: boolean;
  revision: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  deletedAt?: string | number | null;
}

export interface HeroSliderWriteInput {
  type: HeroSliderType;
  images: SliderImage[];
  isActive?: boolean;
}

export interface HeroSliderUpdateInput {
  expectedRevision: number;
  images?: SliderImage[];
  isActive?: boolean;
}

export interface UpdateHeroSliderInput {
  id: string;
  update: HeroSliderUpdateInput;
}

export const getHeroSliders = createServerFn({ method: "GET" }).handler(
  async () => {
    return apiGet<HeroSliderRecord[]>("/settings/hero-sliders");
  },
);

export const createHeroSlider = createServerFn({ method: "POST" })
  .validator((data: HeroSliderWriteInput) => data)
  .handler(async ({ data }) => {
    return apiPost<HeroSliderRecord>("/settings/hero-sliders", data);
  });

export const getHeroSlider = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    return apiGet<HeroSliderRecord>(`/settings/hero-sliders/${id}`);
  });

export const updateHeroSlider = createServerFn({ method: "POST" })
  .validator((data: UpdateHeroSliderInput) => data)
  .handler(async ({ data }) => {
    return apiPut<HeroSliderRecord>(
      `/settings/hero-sliders/${data.id}`,
      data.update,
    );
  });
