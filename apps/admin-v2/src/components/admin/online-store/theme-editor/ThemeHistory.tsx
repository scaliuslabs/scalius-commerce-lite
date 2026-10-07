/**
 * The theme's history: published versions, newest first (Shopify's theme
 * versions), and the draft's restore points (the draft as it was just
 * before a restore or a discard replaced it). A version previews in the
 * editor's frame; both compare with the current draft and restore to the
 * draft, never straight to live. Restoring keeps the draft it replaces as a
 * restore point, so a restore can be undone.
 */
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  getApiV1AdminSettingsThemeDocument,
  getApiV1AdminSettingsThemeRestorePoints,
  getApiV1AdminSettingsThemeVersions,
} from "@scalius/api-client/sdk";
import {
  compareThemeDocuments,
  type StorefrontSection,
  type StorefrontThemeDocument,
  type ThemeDocumentChange,
} from "@scalius/shared/storefront-theme";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { formatDateTime, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { apiData, type ApiResult } from "~/lib/api";

type ThemeVersionSummary = ApiResult<typeof getApiV1AdminSettingsThemeVersions>["versions"][number];
type RestorePoint = ApiResult<typeof getApiV1AdminSettingsThemeRestorePoints>["restorePoints"][number];
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

export const themeVersionsKey = ["theme-versions"] as const;

/** One published version's document, cached by revision (preview and compare share it). */
export const themeVersionDocumentQuery = (revision: number | null) => ({
  queryKey: [...themeVersionsKey, "document", revision] as const,
  queryFn: async () => (await apiData(getApiV1AdminSettingsThemeDocument({ query: { source: "version", revision: revision! } }))).document as StorefrontThemeDocument,
  enabled: revision !== null,
  staleTime: Infinity,
});

const restorePointDocumentQuery = (id: string | null) => ({
  queryKey: [...themeVersionsKey, "restore-point", id] as const,
  queryFn: async () => (await apiData(getApiV1AdminSettingsThemeDocument({ query: { source: "restore-point", id: id! } }))).document as StorefrontThemeDocument,
  enabled: id !== null,
  staleTime: Infinity,
});

/** A change as a sentence in the dashboard language, naming sections by their heading or kind. */
export function useChangeText(documents: readonly StorefrontThemeDocument[], sectionName: (section: StorefrontSection) => string) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const pageName = (page: string) => {
    if (page === "home") return t("page_home");
    if (page.startsWith("template/")) return t(`templateName_${page.slice("template/".length) as "product" | "collection" | "cart" | "page"}`);
    const slug = page.startsWith("landing/") ? page.slice("landing/".length) : page;
    return documents.map((document) => document.pages.landing[slug]?.title).find(Boolean) ?? `/pages/${slug}`;
  };
  const sections = (document: StorefrontThemeDocument, page: string) => {
    if (page === "home") return document.pages.home;
    if (page.startsWith("template/")) return document.pages.templates[page.slice("template/".length) as keyof StorefrontThemeDocument["pages"]["templates"]]?.sections ?? [];
    return document.pages.landing[page.slice("landing/".length)]?.sections ?? [];
  };
  const sectionLabel = (change: Extract<ThemeDocumentChange, { sectionId: string }>) => {
    const section = documents.flatMap((document) => sections(document, change.page)).find((each) => each.id === change.sectionId);
    return section ? sectionName(section) : change.sectionType === "app" ? t("appSection") : store(`section_${change.sectionType}` as MessageKey);
  };
  return (change: ThemeDocumentChange): string => {
    switch (change.kind) {
      case "section-added":
      case "section-removed":
      case "section-changed":
        return t(`change_${change.kind}`, { section: sectionLabel(change), page: pageName(change.page) });
      case "sections-reordered":
      case "page-added":
      case "page-removed":
      case "page-changed":
        return t(`change_${change.kind}`, { page: pageName(change.page) });
      case "settings-changed":
        return t("change_settings-changed", { area: t(`area_${change.area}`) });
    }
  };
}

function ChangeList({ changes, more, text, label }: { changes: readonly ThemeDocumentChange[]; more: number; text: (change: ThemeDocumentChange) => string; label?: string }) {
  const t = useMessages(themeEditorMessages);
  if (changes.length === 0) return <p className="text-body text-muted-foreground">{t("noChanges")}</p>;
  return (
    <ul aria-label={label} className="list-disc space-y-1 ps-5 text-body">
      {changes.map((change, index) => <li key={index}>{text(change)}</li>)}
      {more > 0 ? <li className="text-muted-foreground">{t("moreChanges", { count: more })}</li> : null}
    </ul>
  );
}

/** Compare: what restoring this document would change in the current draft. */
function Compare({ document, draft, sectionName }: {
  document: { isPending: boolean; isError: boolean; data?: StorefrontThemeDocument };
  draft: StorefrontThemeDocument;
  sectionName: (section: StorefrontSection) => string;
}) {
  const t = useMessages(themeEditorMessages);
  const text = useChangeText(document.data ? [draft, document.data] : [draft], sectionName);
  return (
    <div className="space-y-1 rounded-lg bg-muted px-3 py-2">
      <p className="text-body font-medium">{t("compareTitle")}</p>
      {document.isPending ? <p role="status" className="text-body text-muted-foreground">{t("historyLoading")}</p>
        : document.isError ? <p role="alert" className="text-body text-destructive">{t("historyFailed")}</p>
          : <ChangeList changes={compareThemeDocuments(document.data!, draft)} more={0} text={text} label={t("compare")} />}
    </div>
  );
}

function VersionItem({ version, live, draft, previewing, busy, sectionName, onPreview, onRestore }: {
  version: ThemeVersionSummary;
  live: boolean;
  draft: StorefrontThemeDocument;
  previewing: boolean;
  busy: boolean;
  sectionName: (section: StorefrontSection) => string;
  onPreview: () => void;
  onRestore: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const [comparing, setComparing] = useState(false);
  const document = useQuery(themeVersionDocumentQuery(comparing ? version.revision : null));
  const text = useChangeText([draft], sectionName);
  return (
    <li className="space-y-2 border-b border-border px-4 py-4 last:border-b-0" data-theme-version={version.revision}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-heading-sm">{t("version", { revision: version.revision })}</h3>
        {live ? <StatusBadge status="active">{t("live")}</StatusBadge> : null}
        {previewing ? <Badge variant="info">{t("previewingShort")}</Badge> : null}
      </div>
      <p className="text-body text-muted-foreground">
        {t("versionAuthor", {
          name: version.publishedByName ?? t("unknownAuthor"),
          time: formatDateTime(new Date(version.createdAt), { dateStyle: "medium", timeStyle: "short" }),
        })}
      </p>
      {version.note ? <p className="whitespace-pre-wrap text-body">{version.note}</p> : null}
      <ChangeList changes={version.changes} more={version.moreChanges} text={text} />
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" aria-pressed={previewing} onClick={onPreview}>{t("versionPreview")}</Button>
        <Button type="button" variant="outline" size="sm" aria-expanded={comparing} onClick={() => setComparing((open) => !open)}>{t("compare")}</Button>
        {live ? null : <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRestore}>{t("restore")}</Button>}
      </div>
      {comparing ? <Compare document={document} draft={draft} sectionName={sectionName} /> : null}
    </li>
  );
}

function RestorePointItem({ point, draft, busy, sectionName, onRestore }: {
  point: RestorePoint;
  draft: StorefrontThemeDocument;
  busy: boolean;
  sectionName: (section: StorefrontSection) => string;
  onRestore: () => void;
}) {
  const t = useMessages(themeEditorMessages);
  const [comparing, setComparing] = useState(false);
  const document = useQuery(restorePointDocumentQuery(comparing ? point.id : null));
  return (
    <li className="space-y-2 border-b border-border px-4 py-4 last:border-b-0" data-restore-point={point.id}>
      <h3 className="text-heading-sm">{t(point.reason === "discard" ? "restorePointDiscard" : "restorePointRestore")}</h3>
      <p className="text-body text-muted-foreground">
        {t("versionAuthor", {
          name: point.createdByName ?? t("unknownAuthor"),
          time: formatDateTime(new Date(point.createdAt), { dateStyle: "medium", timeStyle: "short" }),
        })}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" aria-expanded={comparing} onClick={() => setComparing((open) => !open)}>{t("compare")}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRestore}>{t("restore")}</Button>
      </div>
      {comparing ? <Compare document={document} draft={draft} sectionName={sectionName} /> : null}
    </li>
  );
}

export function ThemeHistory({ open, onOpenChange, draft, liveRevision, previewRevision, busy, sectionName, onPreview, onRestore, onRestorePoint }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: StorefrontThemeDocument;
  liveRevision: number;
  previewRevision: number | null;
  busy: boolean;
  sectionName: (section: StorefrontSection) => string;
  onPreview: (revision: number | null) => void;
  onRestore: (revision: number) => void;
  onRestorePoint: (id: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const query = useInfiniteQuery({
    queryKey: themeVersionsKey,
    queryFn: ({ pageParam }) => apiData(getApiV1AdminSettingsThemeVersions({ query: pageParam ? { beforeRevision: pageParam } : {} })),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextBeforeRevision ?? undefined,
    enabled: open,
  });
  const points = useQuery({
    queryKey: [...themeVersionsKey, "restore-points"] as const,
    queryFn: () => apiData(getApiV1AdminSettingsThemeRestorePoints()),
    enabled: open,
  });
  const versions = query.data?.pages.flatMap((page) => page.versions) ?? [];
  const retained = query.data?.pages[0]?.retained;
  const restorePoints = points.data?.restorePoints ?? [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <div className="border-b border-border p-4">
          <SheetHeader>
            <SheetTitle>{t("versions")}</SheetTitle>
            <SheetDescription>{retained ? t("versionsHelp", { count: retained }) : t("versionsHelpShort")}</SheetDescription>
          </SheetHeader>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {previewRevision !== null ? (
            <div className="border-b border-border p-4">
              <Button type="button" variant="outline" onClick={() => onPreview(null)}>{t("currentDraft")}</Button>
            </div>
          ) : null}
          {restorePoints.length > 0 ? (
            <section aria-labelledby="theme-restore-points">
              <h2 id="theme-restore-points" className="px-4 pt-4 text-heading-sm">{t("restorePoints")}</h2>
              <p className="px-4 text-body text-muted-foreground">{t("restorePointsHelp")}</p>
              <ol>
                {restorePoints.map((point) => (
                  <RestorePointItem key={point.id} point={point} draft={draft} busy={busy} sectionName={sectionName} onRestore={() => onRestorePoint(point.id)} />
                ))}
              </ol>
            </section>
          ) : null}
          <section aria-labelledby="theme-published-versions">
            <h2 id="theme-published-versions" className="px-4 pt-4 text-heading-sm">{t("publishedVersions")}</h2>
            {query.isPending ? <p role="status" className="p-4 text-body text-muted-foreground">{t("historyLoading")}</p>
              : query.isError ? <p role="alert" className="p-4 text-body text-destructive">{t("historyFailed")}</p>
                : versions.length === 0 ? <p className="p-4 text-body text-muted-foreground">{t("historyEmpty")}</p> : null}
            <ol>
              {versions.map((version) => (
                <VersionItem
                  key={version.revision}
                  version={version}
                  live={version.revision === liveRevision}
                  draft={draft}
                  previewing={previewRevision === version.revision}
                  busy={busy}
                  sectionName={sectionName}
                  onPreview={() => onPreview(version.revision)}
                  onRestore={() => onRestore(version.revision)}
                />
              ))}
            </ol>
            {query.hasNextPage ? (
              <div className="p-4">
                <Button type="button" variant="outline" className="w-full" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t("olderVersions")}</Button>
              </div>
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
