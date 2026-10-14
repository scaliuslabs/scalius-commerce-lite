// One app provider's setup, in a side sheet where its capability lives
// (Shopify: a payment provider's page under Settings → Payments, a carrier's
// under Shipping). Titled with the provider's own name and mark, "by <app>"
// beside it, and only that provider's fields: a pack with ten gateways shows
// one gateway's keys here, never the others'. Saves through the app's sealed
// settings store with the app's revision (secrets write-only, as on the app
// page). Loaded on first use (AppProviderSheetHost).
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveErrorBanner, SaveScope, type SaveScopeState } from "~/components/admin/shared/SaveBar";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appQueryOptions, type AppDetail } from "~/lib/api-query-options/apps";
import { providerPluginId } from "./app-capabilities";
import { localizedAppDetail } from "./app-detail-text";
import { AppIcon } from "./AppIcon";
import { AppSettingControl, useAppSettingsDraft } from "./AppSettingsForm";
import { providerConfigured } from "./app-settings-draft";

type Provider = AppDetail["providers"][number];

function SheetHeading({ title, icon, children }: { title: string; icon?: string | null; children?: ReactNode }) {
  const t = useMessages(appProvidersMessages);
  return (
    <div className="flex items-start gap-3 border-b border-border px-6 py-4">
      {icon !== undefined ? <AppIcon src={icon} size="md" /> : null}
      <SheetHeader className="min-w-0 flex-1">
        <SheetTitle className="break-words">{title}</SheetTitle>
        {children}
      </SheetHeader>
      <SheetClose asChild>
        <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-1 shrink-0" aria-label={t("close")}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      </SheetClose>
    </div>
  );
}

function ProviderFields({ app, provider, state, onCancel }: { app: AppDetail; provider: Provider; state: SaveScopeState; onCancel: () => void }) {
  const t = useMessages(appProvidersMessages);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const canSeeApps = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const form = useAppSettingsDraft(app, { canManage, keys: provider.settings, label: provider.name, idPrefix: "provider-setting" });
  const fields = app.settings.fields.filter((field) => provider.settings.includes(field.key));
  const configured = providerConfigured(app, provider);
  return (
    <>
      <SheetHeading title={provider.name} icon={provider.icon}>
        <SheetDescription>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {canSeeApps ? (
              <Link to="/admin/apps/$pluginId" params={{ pluginId: app.id }} className="text-link hover:underline">
                {t("byApp", { app: app.name })}
              </Link>
            ) : (
              <span>{t("byApp", { app: app.name })}</span>
            )}
            <Badge variant={configured ? "success" : "secondary"}>{t(configured ? "configured" : "notSet")}</Badge>
          </span>
        </SheetDescription>
      </SheetHeading>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4">
        <SaveErrorBanner />
        {app.status !== "active" ? (
          <Alert variant="warning">
            <AlertDescription>{t("activateApp", { app: app.name, name: provider.name })}</AlertDescription>
          </Alert>
        ) : null}
        {!canManage ? <p className="text-body text-muted-foreground">{t("readOnly")}</p> : null}
        {fields.length === 0 ? <p className="text-body text-muted-foreground">{t("noFields", { name: provider.name })}</p> : null}
        {fields.map((field) => (
          <AppSettingControl key={field.key} app={app} field={field} form={form} canManage={canManage} idPrefix="provider-setting" />
        ))}
        {fields.some((field) => field.type === "secret") ? <p className="text-body text-muted-foreground">{t("sheetDescription")}</p> : null}
      </div>
      <SheetFooter>
        <Button type="button" variant="outline" disabled={state.busy} onClick={onCancel}>{t("cancel")}</Button>
        {canManage ? (
          <Button type="button" loading={state.busy} disabled={!state.dirty} onClick={() => void state.saveAll()}>
            {t("save")}
          </Button>
        ) : null}
      </SheetFooter>
    </>
  );
}

function SheetBody({ id, state, onCancel }: { id: string; state: SaveScopeState; onCancel: () => void }) {
  const t = useMessages(appProvidersMessages);
  const locale = useLocale();
  const pluginId = providerPluginId(id);
  const query = useQuery(appQueryOptions(pluginId));
  const app = query.data ? localizedAppDetail(query.data, locale) : null;
  const provider = app?.providers.find((entry) => entry.id === id) ?? null;
  if (app && provider) return <ProviderFields app={app} provider={provider} state={state} onCancel={onCancel} />;
  const name = id.slice(id.indexOf(":") + 1);
  return (
    <>
      <SheetHeading title={provider?.name ?? name} />
      <div className="space-y-3 px-6 py-4">
        {query.isPending ? (
          <div aria-busy className="space-y-3">
            <span className="sr-only">{t("sheetLoading", { name })}</span>
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body text-destructive">{t("sheetFailed", { name })}</p>
            <Button type="button" variant="outline" loading={query.isFetching} onClick={() => void query.refetch()}>{t("retry")}</Button>
          </div>
        ) : (
          <p className="text-body text-muted-foreground">{t("sheetMissing")}</p>
        )}
      </div>
    </>
  );
}

/**
 * The sheet for `providerId` (`<plugin id>:<provider id>`), open while it is
 * set. Closing a sheet with unsaved edits asks first, as a settings dialog does.
 */
export function AppProviderSheet({ providerId, onClose }: { providerId: string | null; onClose: () => void }) {
  const t = useMessages(appProvidersMessages);
  const bar = useMessages(saveBarMessages);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The last provider stays drawn while the sheet slides out.
  const [shown, setShown] = useState(providerId);
  if (providerId !== null && providerId !== shown) setShown(providerId);
  const close = (state: SaveScopeState) => {
    state.discardAll();
    setConfirmDiscard(false);
    onClose();
  };
  const requestClose = (state: SaveScopeState) => {
    if (state.busy) return;
    if (state.dirty) setConfirmDiscard(true);
    else close(state);
  };
  return (
    <SaveScope
      savedMessage={t("saved")}
      render={(state) => (
        <>
          <Sheet open={providerId !== null} onOpenChange={(next) => (next ? undefined : requestClose(state))}>
            <SheetContent className="flex flex-col sm:max-w-lg" aria-describedby={undefined}>
              {shown ? <SheetBody key={shown} id={shown} state={state} onCancel={() => requestClose(state)} /> : null}
            </SheetContent>
          </Sheet>
          <ConfirmDialog
            open={confirmDiscard && state.dirty}
            onOpenChange={setConfirmDiscard}
            title={bar("discardTitle")}
            description={bar("discardDescription")}
            cancelLabel={bar("continueEditing")}
            confirmLabel={bar("discardChanges")}
            onConfirm={() => close(state)}
          />
        </>
      )}
    >
      {null}
    </SaveScope>
  );
}
