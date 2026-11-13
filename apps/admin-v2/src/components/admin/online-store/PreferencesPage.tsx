import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { toast } from "~/lib/toast";
import { postApiV1AdminSettingsSeo } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ChoiceField } from "~/components/ui/field";
import { standaloneLinkTarget } from "~/components/ui/link";
import { Textarea } from "~/components/ui/textarea";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import {
  SEARCH_DESCRIPTION_LENGTH,
  SEARCH_TITLE_LENGTH,
  SearchListingPreview,
} from "~/components/admin/search-listing/SearchListingCard";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { apiData } from "~/lib/api";
import {
  FEED_SAMPLE_MAX,
  countFeedGaps,
  feedDiagnosticsQueryOptions,
  type FeedDiagnostics,
  type FeedFiles,
} from "~/lib/api-query-options/online-store";
import { seoSettingsQueryOptions } from "~/lib/api-query-options/settings";
import { feedFilePath } from "@scalius/shared/catalog-feed-files";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { formatDateTime, useMessages } from "~/i18n";
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

function FeedLink({ id, label, url, help }: { id: string; label: string; url: string; help?: string }) {
  const t = useMessages(onlineStoreMessages);
  return (
    <Field id={id} label={label} help={help}>
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
    </Field>
  );
}

/**
 * The example products under a reason. One product alone on its line is a
 * touch target like a button (DESIGN C6); several run together as a sentence
 * ("A, B and 3 more"), where each link stays inline.
 */
export function FeedSampleLine({ samples, products }: { samples: ReadonlyArray<{ id: string; name: string }>; products: number }) {
  const t = useMessages(onlineStoreMessages);
  const alone = samples.length === 1 && products === 1;
  return (
    <p className="text-muted-foreground">
      {samples.map((sample, index) => (
        <Fragment key={sample.id}>
          {index ? ", " : null}
          <Link
            to="/admin/products/$productId/edit"
            params={{ productId: sample.id }}
            className={alone ? `${standaloneLinkTarget} text-link hover:underline` : "text-link hover:underline"}
          >
            {sample.name}
          </Link>
        </Fragment>
      ))}
      {products > samples.length ? ` ${t("andMore", { count: products - samples.length })}` : null}
    </p>
  );
}

/** The feed URL of one file: the first is the bare URL, a later one names where it starts. */
function feedFileUrl(origin: string, path: string, from: number): string {
  return `${origin}${feedFilePath(path, from)}`;
}

/**
 * The feed links to register. Google and Meta fetch one file per link and one
 * file holds `perFile` products, so a larger catalogue lists every file's link
 * for both, says so, and names a file that more products filled in one second
 * than it can list.
 */
export function FeedFileLinks({ origin, files }: { origin: string; files: FeedFiles | undefined }) {
  const t = useMessages(onlineStoreMessages);
  const channels = [
    { key: "facebook", label: t("facebookFeed"), path: "/api/facebook-feed.xml" },
    { key: "google", label: t("googleFeed"), path: "/api/product-feed.xml" },
  ] as const;
  const list = files?.files ?? [];
  if (list.length <= 1) {
    return channels.map(({ key, label, path }) => (
      <FeedLink key={key} id={`preferences-${key}-feed`} label={label} url={`${origin}${path}`} />
    ));
  }
  const perFile = files!.perFile;
  const overfull = list.filter((file) => file.rows > perFile);
  return (
    <>
      <Alert variant="warning">
        <AlertTitle>{t("feedFilesTitle", { count: list.length })}</AlertTitle>
        <AlertDescription>{t("feedFilesHelp", { perFile })}</AlertDescription>
      </Alert>
      {overfull.map((file) => (
        <Alert key={file.number} variant="destructive">
          <AlertDescription>{t("feedFileOverfull", { number: file.number, perFile, count: file.rows - perFile })}</AlertDescription>
        </Alert>
      ))}
      {channels.map(({ key, label, path }) => list.map((file) => (
        <FeedLink
          key={`${key}-${file.number}`}
          id={`preferences-${key}-feed-${file.number}`}
          label={t("feedFileLabel", { name: label, number: file.number })}
          url={feedFileUrl(origin, path, file.from)}
          help={file.number === 1 || !file.firstCreatedAt
            ? t("feedFileFirst")
            : t("feedFileFrom", { date: formatDateTime(new Date(file.firstCreatedAt), { dateStyle: "medium" }) })}
        />
      )))}
    </>
  );
}

function FeedLinks({ origin }: { origin: string }) {
  const { data } = useQuery(feedDiagnosticsQueryOptions(1, true));
  return <FeedFileLinks origin={origin} files={data?.files} />;
}

type FeedReason = FeedDiagnostics["reasons"][number]["reason"];
/** Products that are off the storefront too: leaving them out of the feed is expected. */
const EXPECTED_REASONS = new Set<FeedReason>(["feed_disabled", "inactive_deleted_unpublished"]);

/**
 * One line with the number of products missing from the feed (counted like
 * Home: fixable reasons only), then every reason with its example products,
 * including the ones left out on purpose. "Show all" lists up to 50 per reason.
 */
function FeedLeftOut() {
  const t = useMessages(onlineStoreMessages);
  const [showAll, setShowAll] = useState(false);
  const preview = useQuery(feedDiagnosticsQueryOptions());
  const full = useQuery({ ...feedDiagnosticsQueryOptions(FEED_SAMPLE_MAX), enabled: showAll });
  const data = (showAll && full.data) || preview.data;
  if (!data) return null;
  const reasons = data.reasons.filter(({ reason, products }) => products > 0 && !EXPECTED_REASONS.has(reason));
  if (!reasons.length) return null;
  const count = countFeedGaps(data);
  const leftOut = reasons.reduce((total, { products }) => total + products, 0) - count;
  const hidden = reasons.some(({ products, samples }) => products > samples.length);
  return (
    <details className="text-body">
      <summary className="cursor-pointer">
        {count > 0
          ? t(count === 1 ? "feedMissingOne" : "feedMissing", { count })
          : t(leftOut === 1 ? "feedLeftOutOne" : "feedLeftOut", { count: leftOut })}
      </summary>
      <ul className="mt-2 space-y-2 ps-4">
        {reasons.map(({ reason, products, samples }) => (
          <li key={reason}>
            <p>
              {t(`feedReason_${reason as Exclude<FeedReason, "feed_disabled" | "inactive_deleted_unpublished">}`)}
              <span className="text-muted-foreground"> · {t(products === 1 ? "oneProduct" : "productCount", { count: products })}</span>
            </p>
            <FeedSampleLine samples={samples} products={products} />
          </li>
        ))}
      </ul>
      {hidden && !showAll ? (
        <Button type="button" variant="link" className="mt-1" onClick={() => setShowAll(true)}>
          {t("showAllProducts")}
        </Button>
      ) : null}
      {data.scan.truncated ? (
        <p className="mt-2 text-muted-foreground">{t("feedScanLimit", { count: data.scan.limit })}</p>
      ) : null}
    </details>
  );
}

function PreferencesCards() {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const { data, refetch } = useSuspenseQuery(seoSettingsQueryOptions());
  const { storefrontUrl } = useStorefrontUrl();
  const origin = trimTrailingCharacter((storefrontUrl ?? ""), "/");
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

      {/* Both choices are saved with the page's save bar: checkboxes (DESIGN F9). */}
      <SectionCard title={t("productFeed")} description={t("productFeedHelp")}>
        <ChoiceField
          id="preferences-product-feed"
          label={t("productFeedOn")}
          control={
            <Checkbox
              id="preferences-product-feed"
              checked={draft.productCatalogEnabled}
              onCheckedChange={(checked) => set({ productCatalogEnabled: checked === true })}
            />
          }
        />
        {draft.productCatalogEnabled ? (
          <>
            <ChoiceField
              id="preferences-sold-out"
              label={t("includeSoldOut")}
              control={
                <Checkbox
                  id="preferences-sold-out"
                  checked={draft.includeUnavailableProducts}
                  onCheckedChange={(checked) => set({ includeUnavailableProducts: checked === true })}
                />
              }
            />
            {origin ? (
              <div className="space-y-3">
                <FeedLeftOut />
                <FeedLinks origin={origin} />
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
    <SaveBarProvider savedMessage={t("preferencesSaved")}>
      <OnlineStorePage title={t("preferencesTitle")}>
        <PreferencesCards />
      </OnlineStorePage>
    </SaveBarProvider>
  );
}
