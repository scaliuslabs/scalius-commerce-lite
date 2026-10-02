import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApiV1AdminSettingsThemeVersions } from "@scalius/api-client/sdk";
import { compareThemeDocuments, type ThemeDocumentChange, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { apiData } from "~/lib/api";
import { formatDateTime, useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";

export interface ThemeVersion {
  revision: number;
  theme: StorefrontThemeDocument;
  summary: string[];
  changes: ThemeDocumentChange[];
  note: string | null;
  publishedByName: string | null;
  createdAt: string | null;
}

export const themeVersionsKey = ["theme-versions"] as const;

export function ThemeHistory({ theme, busy, previewRevision, onPreview, onRestore }: {
  theme: StorefrontThemeDocument;
  busy: boolean;
  previewRevision: number | null;
  onPreview: (revision: number | null) => void;
  onRestore: (revision: number) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const changeText = (change: ThemeDocumentChange) => t(`change_${change.kind}`, { page: ["home", "product", "collection", "search"].includes(change.page) ? t(`page_${change.page as "home" | "product" | "collection" | "search"}`) : change.page === "theme" ? t("tabTheme") : change.page, section: change.sectionId ?? "", path: (change.path ?? change.sectionId ?? t("paneSettings")).replaceAll(".", " → ") });
  const [comparison, setComparison] = useState<number | null>(null);
  const query = useQuery({ queryKey: themeVersionsKey, queryFn: async () => {
    const result = await apiData(getApiV1AdminSettingsThemeVersions());
    return result.versions as unknown as ThemeVersion[];
  } });
  return (
    <section className="space-y-4 p-4">
      <h2 className="text-heading-sm">{t("history")}</h2>
      {previewRevision !== null ? <Button type="button" variant="outline" onClick={() => onPreview(null)}>{t("currentDraft")}</Button> : null}
      {query.isPending ? <p role="status" className="text-body text-muted-foreground">{t("historyLoading")}</p>
        : query.isError ? <p role="alert" className="text-body text-destructive">{t("historyFailed")}</p>
          : query.data.length === 0 ? <p className="text-body text-muted-foreground">{t("historyEmpty")}</p> : null}
      <ol className="space-y-4">
        {(query.data ?? []).map((version) => {
          const changes = comparison === version.revision ? compareThemeDocuments(version.theme, theme) : null;
          return <li key={version.revision} className="space-y-2 border-b border-border pb-4">
            <h3 className="text-body font-medium">{t("version", { revision: version.revision })}</h3>
            <p className="text-body text-muted-foreground">{t("versionAuthor", { name: version.publishedByName ?? t("unknownAuthor"), time: version.createdAt ? formatDateTime(new Date(version.createdAt), { dateStyle: "medium", timeStyle: "short" }) : "—" })}</p>
            {version.note ? <p className="whitespace-pre-wrap text-body">{version.note}</p> : null}
            <ul className="list-disc space-y-1 pl-4 text-body text-muted-foreground">{(version.changes ?? []).map((change, index) => <li key={index}>{changeText(change)}</li>)}</ul>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" aria-pressed={previewRevision === version.revision} onClick={() => onPreview(version.revision)}>{t("versionPreview")}</Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setComparison(comparison === version.revision ? null : version.revision)}>{t("compare")}</Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onRestore(version.revision)}>{t("restore")}</Button>
            </div>
            {changes ? <ul aria-label={t("compare")} className="list-disc space-y-1 pl-4 text-body">{changes.length === 0 ? <li>{t("noChanges")}</li> : changes.map((change, index) => <li key={index}>{changeText(change)}</li>)}</ul> : null}
          </li>;
        })}
      </ol>
    </section>
  );
}
