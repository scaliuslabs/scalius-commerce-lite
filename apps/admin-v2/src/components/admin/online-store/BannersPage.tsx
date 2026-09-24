import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ImageIcon, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  postApiV1AdminSettingsHeroSliders,
  putApiV1AdminSettingsHeroSlidersById,
} from "@scalius/api-client/sdk";
import {
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  HERO_SLIDE_LIMIT,
  HERO_SLIDE_PRESENTATION,
  validateAndNormalizeHeroSlides,
  type HeroSlide,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { MediaManager, type MediaFile } from "~/components/admin/media-manager";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import { SortableList } from "~/components/admin/shared/SortableList";
import { apiData } from "~/lib/api";
import {
  heroSlidersQueryOptions,
  type HeroSliderDocument,
} from "~/lib/api-query-options/online-store";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { HomepageSectionsCards } from "./HomepageSectionsCards";
import { SlideRow, bannerFieldId } from "./SlideRow";
import { OnlineStorePage, SectionCard, failSave, useDocumentDraft } from "./shared";

interface BannerDraft {
  isActive: boolean;
  images: HeroSlide[];
}

const NO_BANNERS: BannerDraft = { isActive: false, images: [] };

function newSlideId(): string {
  return `img_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function BannerCard({ viewport }: { viewport: HeroSlideViewport }) {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data: sliders, refetch } = useSuspenseQuery(heroSlidersQueryOptions());
  const slider = sliders.find((candidate) => candidate.type === viewport) ?? null;
  const saved = useMemo<BannerDraft>(
    () => (slider ? { isActive: slider.isActive, images: slider.images } : NO_BANNERS),
    [slider],
  );
  const { draft, setDraft } = useDocumentDraft<BannerDraft>({
    label: t(viewport === "desktop" ? "desktopBanners" : "phoneBanners"),
    saved,
    fields: (path, value) => {
      const [group, index, field] = path.split(".");
      const slide = group === "images" ? value.images[Number(index)] : undefined;
      if (!slide) return undefined;
      const control = { title: "text", heading: "heading", buttonLabel: "button", link: "link" } as const;
      return field in control ? bannerFieldId(slide.id, control[field as keyof typeof control]) : undefined;
    },
    invalid: (value) =>
      (value.isActive && value.images.length === 0) ||
      !validateAndNormalizeHeroSlides(value.images).ok,
    save: async (value) => {
      try {
        const next: HeroSliderDocument = slider
          ? await apiData(putApiV1AdminSettingsHeroSlidersById({
              path: { id: slider.id },
              body: { expectedRevision: slider.revision, ...value },
            }))
          : await apiData(postApiV1AdminSettingsHeroSliders({
              body: { type: viewport, ...value },
            }));
        queryClient.setQueryData(heroSlidersQueryOptions().queryKey, (current) => [
          ...(current ?? []).filter((candidate) => candidate.type !== viewport),
          next,
        ]);
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const presentation = HERO_SLIDE_PRESENTATION[viewport];
  const full = draft.images.length >= HERO_SLIDE_LIMIT;

  const addImages = (files: MediaFile[]) => {
    const accepted = files.slice(0, HERO_SLIDE_LIMIT - draft.images.length);
    if (accepted.length < files.length) {
      toast.warning(t("bannerLimit", { count: HERO_SLIDE_LIMIT }));
    }
    setDraft((current) => ({
      ...current,
      images: [
        ...current.images,
        ...accepted.map((file) => ({
          id: newSlideId(),
          url: file.url,
          title: file.altText?.trim() || "",
          heading: "",
          buttonLabel: "",
          link: "",
          focalPoint: { ...HERO_SLIDE_DEFAULT_FOCAL_POINT },
        })),
      ],
    }));
  };
  const updateSlide = (id: string, updates: Partial<HeroSlide>) =>
    setDraft((current) => ({
      ...current,
      images: current.images.map((slide) => (slide.id === id ? { ...slide, ...updates } : slide)),
    }));

  const switchId = `banners-${viewport}-visible`;
  return (
    <SectionCard
      title={t(viewport === "desktop" ? "desktopBanners" : "phoneBanners")}
      description={t("bannerSize", { width: presentation.width, height: presentation.height })}
      action={
        <MediaManager
          capability="image"
          onSelect={(file) => addImages([file])}
          onSelectMultiple={addImages}
          trigger={
            <Button type="button" variant="outline" size="sm" disabled={full}>
              <Plus /> {t("addBanners")}
            </Button>
          }
        />
      }
    >
      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <Label htmlFor={switchId}>{t("showOnHomepage")}</Label>
        <Switch
          id={switchId}
          checked={draft.isActive}
          onCheckedChange={(isActive) => setDraft((current) => ({ ...current, isActive }))}
        />
      </div>
      {draft.isActive && draft.images.length === 0 ? (
        <p role="alert" className="text-body text-destructive">{t("bannersRequired")}</p>
      ) : null}
      {draft.images.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-body text-muted-foreground">
          <ImageIcon className="size-5" aria-hidden />
          {t("noBanners")}
        </div>
      ) : (
        <SortableList
          items={draft.images}
          onReorder={(images) => setDraft((current) => ({ ...current, images }))}
          renderItem={(slide, sortable) => (
            <SlideRow
              slide={slide}
              index={draft.images.indexOf(slide)}
              viewport={viewport}
              sortable={sortable}
              onChange={(updates) => updateSlide(slide.id, updates)}
              onRemove={() => setDraft((current) => ({
                ...current,
                images: current.images.filter((candidate) => candidate.id !== slide.id),
              }))}
            />
          )}
        />
      )}
    </SectionCard>
  );
}

export function BannersPage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider>
      <OnlineStorePage title={t("bannersTitle")}>
        <BannerCard viewport="desktop" />
        <BannerCard viewport="mobile" />
        <HomepageSectionsCards />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
