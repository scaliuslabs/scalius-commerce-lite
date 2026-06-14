import { createServerFn } from "@tanstack/react-start";
import { apiGet, apiPost, apiPut } from "../api.server";

export type HeroSliderType = "desktop" | "mobile";

export interface SliderImage {
  id: string;
  url: string;
  title: string;
  link: string;
}

export interface HeroSliderRecord {
  id: string;
  type: HeroSliderType;
  images: SliderImage[];
  isActive: boolean;
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

export const updateHeroSlider = createServerFn({ method: "POST" })
  .validator((data: UpdateHeroSliderInput) => data)
  .handler(async ({ data }) => {
    return apiPut<HeroSliderRecord>(
      `/settings/hero-sliders/${data.id}`,
      data.update,
    );
  });
