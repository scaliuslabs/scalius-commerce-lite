import { queryOptions } from "@tanstack/react-query";
import { getHeroSliders } from "../api-functions/hero-sliders";
import { queryKeys } from "../query-keys";

const CONFIG_STALE_TIME_MS = 1000 * 60 * 30;

export const heroSlidersQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.settings.heroSliders(),
    queryFn: () => getHeroSliders(),
    staleTime: CONFIG_STALE_TIME_MS,
  });
