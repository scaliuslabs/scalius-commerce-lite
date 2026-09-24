import { useMemo } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { postApiV1AdminSettingsSeo } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import {
  SEARCH_DESCRIPTION_LENGTH,
  SEARCH_TITLE_LENGTH,
  SearchListingPreview,
} from "~/components/admin/search-listing/SearchListingCard";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { apiData } from "~/lib/api";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { ImageField } from "./ImageField";
import { Field, OnlineStorePage, SectionCard, failSave, useDocumentDraft } from "./shared";

interface Preferences {
  homepageTitle: string;
  homepageMetaDescription: string;
  socialImage: string;
  productCatalogEnabled: boolean;
  includeUnavailableProducts: boolean;
}

function FeedLink({ id, label, url }: { id: string; label: string; url: string }) {
  const t = useMessages(onlineStoreMessages);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} value={url} readOnly />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          aria-label={t("copyLinkFor", { name: label })}
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => toast.success(t("linkCopied")),
              () => toast.error(t("copyFailed")),
            );
          }}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

function PreferencesCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(seoSettingsQueryOptions());
  const { storefrontUrl } = useStorefrontUrl();
  const origin = (storefrontUrl ?? "").replace(/\/+$/, "");
  const saved = useMemo<Preferences>(() => ({
    homepageTitle: data.homepageTitle,
    homepageMetaDescription: data.homepageMetaDescription,
    socialImage: data.socialImage,
    productCatalogEnabled: data.discovery.feeds.productCatalogEnabled,
    includeUnavailableProducts: data.discovery.feeds.includeUnavailableProducts,
  }), [data]);
  const { draft, setDraft } = useDocumentDraft<Preferences>({
    label: t("preferencesTitle"),
    saved,
    fields: (path) => ({
      homepageTitle: "preferences-title",
      homepageMetaDescription: "preferences-description",
    } as Record<string, string>)[path],
    save: async (next) => {
      try {
        await apiData(postApiV1AdminSettingsSeo({
          body: {
            homepageTitle: next.homepageTitle,
            homepageMetaDescription: next.homepageMetaDescription,
            socialImage: next.socialImage,
            discovery: {
              feeds: {
                productCatalogEnabled: next.productCatalogEnabled,
                includeUnavailableProducts: next.includeUnavailableProducts,
              },
            },
            expectedRevision: data.revision,
          },
        }));
        await queryClient.invalidateQueries({ queryKey: seoSettingsQueryOptions().queryKey });
      } catch (error) {
        failSave(error, () => void refetch());
      }
    },
  });
  const set = (updates: Partial<Preferences>) => setDraft((current) => ({ ...current, ...updates }));

  return (
    <>
      <SectionCard title={t("homepageListing")} description={t("homepageListingHelp")}>
        {draft.homepageTitle ? (
          <SearchListingPreview
            url={origin || "/"}
            title={draft.homepageTitle}
            description={draft.homepageMetaDescription}
          />
        ) : null}
        <Field
          id="preferences-title"
          label={t("homepageTitle")}
          help={t("charactersUsed", { count: draft.homepageTitle.length, limit: SEARCH_TITLE_LENGTH })}
        >
          <Input
            id="preferences-title"
            value={draft.homepageTitle}
            maxLength={200}
            aria-describedby="preferences-title-note"
            onChange={(event) => set({ homepageTitle: event.target.value })}
          />
        </Field>
        <Field
          id="preferences-description"
          label={t("homepageDescription")}
          help={t("charactersUsed", { count: draft.homepageMetaDescription.length, limit: SEARCH_DESCRIPTION_LENGTH })}
        >
          <Textarea
            id="preferences-description"
            value={draft.homepageMetaDescription}
            maxLength={1000}
            rows={3}
            aria-describedby="preferences-description-note"
            onChange={(event) => set({ homepageMetaDescription: event.target.value })}
          />
        </Field>
      </SectionCard>

      <SectionCard title={t("socialImage")} description={t("socialImageHelp")}>
        <ImageField
          label={t("socialImageLabel")}
          src={draft.socialImage}
          wide
          onChange={(image) => set({ socialImage: image.src })}
        />
      </SectionCard>

      <SectionCard
        title={t("productFeed")}
        description={t("productFeedHelp")}
        action={
          <Switch
            checked={draft.productCatalogEnabled}
            aria-label={t("productFeed")}
            onCheckedChange={(productCatalogEnabled) => set({ productCatalogEnabled })}
          />
        }
      >
        {draft.productCatalogEnabled ? (
          <>
            <div className="flex items-start gap-3">
              <span className="flex h-lh items-center text-body">
                <Checkbox
                  id="preferences-sold-out"
                  checked={draft.includeUnavailableProducts}
                  onCheckedChange={(checked) => set({ includeUnavailableProducts: checked === true })}
                />
              </span>
              <Label htmlFor="preferences-sold-out">{t("includeSoldOut")}</Label>
            </div>
            {origin ? (
              <div className="space-y-3">
                <FeedLink id="preferences-facebook-feed" label={t("facebookFeed")} url={`${origin}/api/facebook-feed.xml`} />
                <FeedLink id="preferences-google-feed" label={t("googleFeed")} url={`${origin}/api/product-feed.xml`} />
              </div>
            ) : (
              <p className="text-body text-muted-foreground">{t("feedNeedsStoreAddress")}</p>
            )}
          </>
        ) : null}
      </SectionCard>
    </>
  );
}

export function PreferencesPage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <SaveBarProvider>
      <OnlineStorePage title={t("preferencesTitle")}>
        <PreferencesCards />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
