// Settings → Taxes: what the taxes page and a country's tax page share.
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { Switch } from "~/components/ui/switch";
import { useHasPermission } from "~/contexts/PermissionContext";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { TaxClassRecord } from "~/lib/api-query-options/taxes";
import { queryKeys } from "~/lib/query-keys";
import { formatNumber, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { taxesMessages } from "~/i18n/settings-taxes";

export const NONE = "__none__";

export function useCanManageTaxes() {
  return useHasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
}

/**
 * Tax writes carry the version they were read at. A stale one is refused:
 * reload the latest and ask the merchant to save again.
 */
export function useWriteFailure() {
  const queryClient = useQueryClient();
  const t = useMessages(taxesMessages);
  const common = useMessages(settingsMessages);
  return async (error: unknown, conflictMessage = t("conflict")) => {
    if (!isAdminApiConflictError(error)) {
      toast.error(common("saveFailed"));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    toast.error(conflictMessage);
  };
}

/**
 * For save-bar saves: the page banner reports the problem (no toast). A
 * conflict reloads the newer version and keeps the merchant's edits.
 */
export function useSaveFailure(key: readonly unknown[] = queryKeys.settings.taxes()) {
  const queryClient = useQueryClient();
  const t = useMessages(taxesMessages);
  return async (error: unknown): Promise<never> => {
    if (isAdminApiConflictError(error)) {
      await queryClient.invalidateQueries({ queryKey: key });
      throw new Error(t("conflict"));
    }
    throw error;
  };
}

export function useRefreshTaxes() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
}

export function SwitchRow({
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 text-body">
      <span>
        <span className="block font-medium">{label}</span>
        {help ? <span className="block text-muted-foreground">{help}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export function useGroupName() {
  const t = useMessages(taxesMessages);
  return (group: TaxClassRecord) => (group.isExempt ? t("taxFreeName", { name: group.name }) : group.name);
}

export function money(amount: number, currency: string) {
  return formatNumber(amount, { style: "currency", currency, maximumFractionDigits: 2 });
}
