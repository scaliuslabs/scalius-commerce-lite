// After store setup chose Bangladesh: the Bangladesh pack (SMS gateways,
// courier fraud checks, the City/Thana/Area places) in one step, as Shopify
// offers a region's apps during setup.
// - Compiled into this store (listed in scalius.plugins.json): Activate,
//   through the same consent dialog as the Apps page. Activation loads the
//   places and moves any SMS or fraud keys saved before the pack.
// - Not compiled in: the operator's `pnpm plugin add` command, as the Apps
//   page shows it.
// - Active: the next steps.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { storeSetupMessages } from "~/i18n/store-setup";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appQueryOptions, appsQueryOptions } from "~/lib/api-query-options/apps";
import { ActivateAppDialog } from "../apps/AppDialogs";
import { AppIcon } from "../apps/AppIcon";

export { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";
import { BANGLADESH_PACK_ID } from "~/lib/bangladesh-pack";

export function BangladeshPackStep({ onDone }: { onDone: () => void }) {
  const t = useMessages(storeSetupMessages);
  const { hasPermission, isSuperAdmin } = usePermissions();
  const canSeeApps = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const apps = useQuery({ ...appsQueryOptions(), enabled: canSeeApps });
  const installed = apps.data?.apps.find((app) => app.id === BANGLADESH_PACK_ID) ?? null;
  const available = apps.data?.available.find((app) => app.id === BANGLADESH_PACK_ID) ?? null;
  const detail = useQuery({ ...appQueryOptions(BANGLADESH_PACK_ID), enabled: Boolean(installed) && isSuperAdmin });
  const [activating, setActivating] = useState(false);
  const active = installed?.status === "active" && !installed.needsApproval;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="bd-pack-title">
      <header className="flex items-center gap-3">
        <AppIcon src={installed?.icon ?? available?.icon ?? null} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 id="bd-pack-title" className="text-heading-lg font-semibold">{t("bdPackTitle")}</h1>
          <p className="text-body text-muted-foreground">{t("bdPackDescription")}</p>
        </div>
      </header>

      {!canSeeApps ? (
        <p className="text-body">{t("bdPackNoAccess")}</p>
      ) : apps.isPending ? null : active ? (
        <div className="flex flex-col gap-3">
          <Badge variant="success" className="self-start">{t("bdPackActive")}</Badge>
          <p className="text-body">{t("bdPackNext")}</p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-body">
            <li><Link className="text-link hover:underline" to="/admin/settings/shipping" hash="couriers">{t("bdPackNextKeys")}</Link></li>
            <li><Link className="text-link hover:underline" to="/admin/settings/notifications">{t("bdPackNextSms")}</Link></li>
            <li><Link className="text-link hover:underline" to="/admin/settings/integrations">{t("bdPackNextFraud")}</Link></li>
            <li><Link className="text-link hover:underline" to="/admin/settings/shipping">{t("bdPackNextZones")}</Link></li>
          </ul>
        </div>
      ) : installed ? (
        <div className="flex flex-col gap-3">
          <p className="text-body">{t("bdPackActivateBody")}</p>
          {isSuperAdmin ? (
            <Button type="button" className="self-start" loading={detail.isPending} disabled={!detail.data} onClick={() => setActivating(true)}>
              {t("bdPackActivate")}
            </Button>
          ) : (
            <p className="text-body text-muted-foreground">{t("bdPackAskSuperAdmin")}</p>
          )}
          {detail.data ? <ActivateAppDialog app={detail.data} open={activating} onOpenChange={setActivating} /> : null}
        </div>
      ) : available ? (
        <div className="flex flex-col gap-1">
          <p className="text-body">{t("bdPackInstallBody")}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2"><code>{available.installCommand}</code></pre>
        </div>
      ) : (
        <p className="text-body">{t("bdPackUnavailable")}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant={active ? "default" : "ghost"} onClick={onDone}>
          {active ? t("bdPackDone") : t("skip")}
        </Button>
      </div>
    </section>
  );
}
