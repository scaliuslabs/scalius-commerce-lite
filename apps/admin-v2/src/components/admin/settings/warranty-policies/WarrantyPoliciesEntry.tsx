// Settings › Policies' way in to Warranty policies (as Shipping › Delivery areas):
// how many live policies there are, and "Manage".
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Button } from "~/components/ui/button";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { warrantyPoliciesQueryOptions } from "../../warranty/warranty-api";

export function WarrantyPoliciesEntry() {
  const t = useMessages(warrantyMessages);
  const canView = useHasPermission(PERMISSIONS.PRODUCTS_VIEW);
  const { data, isError, refetch } = useQuery({ ...warrantyPoliciesQueryOptions(false), enabled: canView });
  if (!canView) return null;
  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;
  const summary = data.length === 0
    ? t("entryEmpty")
    : data.length === 1 ? t("entrySummaryOne") : t("entrySummary", { count: data.length });
  return (
    <SettingsCard
      title={t("title")}
      description={t("entryDescription")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/settings/policies/warranty">{t("manage")}</Link>
        </Button>
      }
    >
      <p className="text-body">{summary}</p>
    </SettingsCard>
  );
}
