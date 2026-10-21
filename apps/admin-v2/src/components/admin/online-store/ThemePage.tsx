/**
 * Online store → Themes (Shopify's themes page): the current theme, whether
 * its draft has unpublished changes and who published last, with Customize
 * (the theme editor, where every setting lives), Preview and Publish; and
 * the template library, where choosing a template restyles the draft while
 * keeping the merchant's content. Installed apps' templates sit beside the
 * built-in ones with an App badge; choosing one applies it to the draft the
 * same way (`applyStorefrontAppTemplate`).
 */
import { useMemo, useState, type CSSProperties } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import {
  postApiV1AdminSettingsThemeDraft,
  postApiV1AdminSettingsThemePublish,
} from "@scalius/api-client/sdk";
import type {
  ResolvedStorefrontThemeLayout,
  StoreShape,
  StorefrontTemplateId,
  StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { useHasPermission } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { formatDateTime, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorFull } from "~/i18n/theme-editor-panes";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { themeWorkspaceQueryOptions, type ThemeWorkspaceDocument } from "~/lib/api-query-options/online-store";
import { OnlineStorePage, SectionCard, actionErrorText } from "./shared";
import { HeaderRows, ProductTile, Sketch, VisualChoice } from "./ThemeChoices";
import { useOpenThemePreview } from "./theme-preview";
import { TEMPLATE_THEMES, appTemplates, applyAppTemplate, applyTemplate, resolveThemeForStore, selectedTemplate } from "./theme-settings";
import { ThemeAppsUnavailableAlert } from "~/components/admin/apps/ThemeAppParts";
import { themeAppsUnavailable, type ThemeAppsProblem } from "~/components/admin/apps/theme-app-parts";

type Theme = StorefrontThemeDocument;
type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/** A template's whole look in its own colours: header shape and product cards, as this store renders them. */
function TemplatePreview({ theme, layout, className = "h-28" }: { theme: Theme; layout: ResolvedStorefrontThemeLayout; className?: string }) {
  const { colors, radius } = theme.tokens;
  return (
    <Sketch
      palette={{
        paper: colors.background,
        ink: colors.foreground,
        line: colors["muted-foreground"],
        soft: colors.muted,
        edge: colors.border,
        accent: colors.primary,
      }}
      className={className}
    >
      {theme.template === "marketplace" ? (
        <span
          data-marketplace-preview
          style={{ "--sk-purchase": colors.accent } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col gap-1"
        >
          <span data-marketplace-header className="flex h-7 shrink-0 flex-col gap-1 rounded-xs bg-(--sk-ink) p-1">
            <span className="flex items-center gap-1">
              <span className="h-1 w-4 bg-(--sk-paper)" />
              <span className="flex h-2 flex-1 overflow-clip rounded-xs bg-(--sk-paper)">
                <span className="ms-auto w-2 bg-(--sk-purchase)" />
              </span>
              <span className="size-1 rounded-full bg-(--sk-paper)" />
              <span className="size-1 rounded-full bg-(--sk-paper)" />
            </span>
            <span className="flex gap-1">
              <span className="h-0.5 w-4 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
              <span className="h-0.5 w-3 bg-(--sk-paper)" />
            </span>
          </span>
          <span className="flex min-h-0 flex-1 gap-1">
            <span data-marketplace-category-grid className="grid min-w-0 flex-1 grid-cols-2 gap-1 border-e border-(--sk-edge) pe-1">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className="flex min-h-0 flex-col gap-0.5 rounded-xs border border-(--sk-edge) p-0.5">
                  <span className="min-h-0 flex-1 bg-(--sk-soft)" />
                  <span className="h-0.5 w-3/4 bg-(--sk-line)" />
                  <span className="h-0.5 w-1/2 bg-(--sk-ink)" />
                </span>
              ))}
            </span>
            <span data-marketplace-search-list className="flex min-w-0 flex-1 flex-col gap-1">
              {[0, 1].map((index) => (
                <span key={index} data-marketplace-result-row className="flex min-h-0 flex-1 gap-1 border-b border-(--sk-edge) pb-0.5 last:border-0">
                  <span className="aspect-square h-full max-h-7 shrink-0 rounded-xs bg-(--sk-soft)" />
                  <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                    <span className="h-1 w-4/5 bg-(--sk-line)" />
                    <span className="h-0.5 w-2/3 bg-(--sk-line)" />
                    <span className="h-1 w-1/3 bg-(--sk-ink)" />
                    <span className="h-1 w-1/2 rounded-full bg-(--sk-purchase)" />
                  </span>
                </span>
              ))}
            </span>
          </span>
        </span>
      ) : (
        <>
          <HeaderRows kind={layout.header} />
          <span className="mt-1 flex justify-center gap-1.5">
            {[0, 1, 2].map((index) => (
              <ProductTile key={index} card={layout.productCard} radius={radius} badge={index === 0} className="max-w-11" />
            ))}
          </span>
        </>
      )}
    </Sketch>
  );
}

function ThemeOverview({ workspace, refetch }: {
  workspace: ThemeWorkspaceDocument;
  refetch: () => Promise<unknown>;
}) {
  const t = useMessages(onlineStoreMessages);
  const editor = useMessages(themeEditorFull);
  const queryClient = useQueryClient();
  const openPreview = useOpenThemePreview();
  // Staff who may view settings but not edit them see the theme, preview it and open the editor read-only.
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_THEME_EDIT);
  const storeShape = workspace.storeShape as StoreShape;
  const draft = workspace.draft.theme as Theme;
  /** A built-in template's id, or an app template's key (`<app id>/<template id>`). */
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [busy, setBusy] = useState<"template" | "publish" | "preview" | null>(null);
  /** The apps a refused publish named: listed in the card, each with a link to its page. */
  const [appsProblem, setAppsProblem] = useState<{ apps: ThemeAppsProblem[]; moreParts: number } | null>(null);
  const option = (key: string) => t(key as MessageKey);
  // Each app template as this draft would look with it applied.
  const fromApps = useMemo(() => appTemplates(workspace.apps).map((template) => ({ template, theme: applyAppTemplate(template, draft) })), [workspace.apps, draft]);
  // An applied app template is the current one while the draft names it; otherwise the built-in one its look matches.
  const appTemplate = draft.apps?.template ? fromApps.find((each) => each.template.key === draft.apps?.template)?.template : undefined;
  const builtIn = draft.apps?.template ? null : selectedTemplate(draft);
  const selected = appTemplate?.key ?? builtIn;
  const templateName = (id: string) => fromApps.find((each) => each.template.key === id)?.template.name ?? option(`template_${id}`);
  const changed = workspace.draftDiffersFromLive;
  const refresh = async () => {
    await refetch();
    void queryClient.invalidateQueries({ queryKey: ["theme-versions"] });
  };
  const fail = async (error: unknown) => {
    toast.error(isAdminApiConflictError(error) ? t("themeActionConflict") : actionErrorText(error));
    if (isAdminApiConflictError(error)) await refresh();
  };

  const chooseTemplate = async (id: string) => {
    const fromApp = fromApps.find((each) => each.template.key === id);
    setBusy("template");
    try {
      await apiData(postApiV1AdminSettingsThemeDraft({
        body: {
          expectedDraftRevision: workspace.draft.revision,
          basePublishedRevision: workspace.draft.basePublishedRevision,
          theme: fromApp ? fromApp.theme : applyTemplate(id as StorefrontTemplateId, draft),
        },
      }));
      toast.success(editor("templateApplied"));
      await refresh();
    } catch (error) {
      await fail(error);
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setBusy("publish");
    setAppsProblem(null);
    try {
      await apiData(postApiV1AdminSettingsThemePublish({
        body: { expectedPublishedRevision: workspace.published.revision, expectedDraftRevision: workspace.draft.revision },
      }));
      toast.success(t("themePublished"));
      await refresh();
    } catch (error) {
      const unavailable = themeAppsUnavailable(error);
      if (unavailable) setAppsProblem(unavailable);
      else await fail(error);
    } finally {
      setBusy(null);
    }
  };

  const preview = async () => {
    setBusy("preview");
    const result = await openPreview(workspace.draft.revision, "/");
    setBusy(null);
    if (result !== "opened") toast.error(t("themePreviewFailed"));
  };

  return (
    <>
      <SectionCard title={editor("currentTheme")}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start" data-current-theme>
          <div className="w-full shrink-0 sm:w-56">
            <TemplatePreview theme={draft} layout={resolveThemeForStore(draft, storeShape).layout} className="h-32" />
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1">
              <p className="flex flex-wrap items-center gap-2 text-heading-md">
                {selected ? templateName(selected) : t("templateCustomBasedOn", { name: option(`template_${draft.template}`) })}
                <StatusBadge status={changed ? "draft" : "active"}>{changed ? editor("notPublished") : editor("live")}</StatusBadge>
              </p>
              <p className="text-body text-muted-foreground">
                {changed ? t("themeDraftNotLive") : t("themeLive")}
              </p>
              {workspace.lastPublished ? (
                <p className="text-body text-muted-foreground">
                  {editor("lastPublished", {
                    name: workspace.lastPublished.publishedByName ?? editor("unknownAuthor"),
                    time: formatDateTime(new Date(workspace.lastPublished.createdAt), { dateStyle: "medium", timeStyle: "short" }),
                  })}
                </p>
              ) : null}
              <p className="text-body text-muted-foreground">{editor("customizeHelp")}</p>
            </div>
            {appsProblem ? <ThemeAppsUnavailableAlert apps={appsProblem.apps} moreParts={appsProblem.moreParts} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/admin/online-store/theme/editor">{editor("customize")}</Link>
              </Button>
              {/* Nothing to preview until a draft exists: no disabled button without a reason (C5). */}
              {workspace.draft.revision >= 1 ? (
                <Button type="button" variant="outline" disabled={busy !== null} loading={busy === "preview"} onClick={() => void preview()}>
                  {editor("preview")}
                </Button>
              ) : null}
              {changed && canEdit ? (
                <Button type="button" variant="outline" disabled={busy !== null} loading={busy === "publish"} onClick={() => setConfirmPublish(true)}>
                  {t("themePublish")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("themeTemplates")} description={editor(canEdit ? "templatesHelp" : "readOnly")}>
        <VisualChoice
          label={t("themeTemplates")}
          value={selected}
          className="grid-cols-2 sm:grid-cols-3"
          options={[
            ...TEMPLATE_THEMES.map((template) => ({
              value: template.id as string,
              label: option(`template_${template.id}`),
              help: option(`template_${template.id}Help`),
              sketch: <TemplatePreview theme={template.theme} layout={resolveThemeForStore(template.theme, storeShape).layout} />,
            })),
            ...fromApps.map(({ template, theme }) => ({
              value: template.key,
              label: template.name,
              badge: <Badge variant="secondary">{editor("appBadge")}</Badge>,
              help: [template.description, editor("appFrom", { app: template.app.name })].filter(Boolean).join(" "),
              sketch: <TemplatePreview theme={theme} layout={resolveThemeForStore(theme, storeShape).layout} />,
            })),
          ]}
          onChange={(id) => { if (canEdit && id !== selected && busy === null) setPendingTemplate(id); }}
        />
      </SectionCard>

      <ConfirmDialog
        open={pendingTemplate !== null}
        onOpenChange={(open) => { if (!open) setPendingTemplate(null); }}
        title={t("templateReplaceTitle", { name: pendingTemplate ? templateName(pendingTemplate) : "" })}
        description={editor(fromApps.some((each) => each.template.key === pendingTemplate) ? "appTemplateReplaceBody" : "templateReplaceBody")}
        confirmLabel={t("templateReplaceConfirm")}
        variant="default"
        onConfirm={() => {
          const id = pendingTemplate;
          setPendingTemplate(null);
          if (id) void chooseTemplate(id);
        }}
      />
      <ConfirmDialog
        open={confirmPublish}
        onOpenChange={setConfirmPublish}
        title={t("themePublishConfirmTitle")}
        description={t("themePublishConfirmBody")}
        confirmLabel={t("themePublish")}
        variant="default"
        onConfirm={() => { setConfirmPublish(false); void publish(); }}
      />
    </>
  );
}

function ThemeSettings() {
  const { data: workspace, refetch } = useSuspenseQuery(themeWorkspaceQueryOptions());
  return <ThemeOverview workspace={workspace} refetch={refetch} />;
}

export function ThemePage() {
  const t = useMessages(onlineStoreMessages);
  return (
    <OnlineStorePage title={t("themeTitle")}>
      <ThemeSettings />
    </OnlineStorePage>
  );
}
