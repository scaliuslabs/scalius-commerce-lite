// Custom access for a new key: the opt-in scopes no preset reaches (the inbox
// and review moderation, `apps/api/src/agent-access/grant-scopes.ts`), every
// other permission, the riskiest action allowed and whether deletes and money
// actions wait for the merchant's approval. Loaded only when Custom is chosen.
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { PermissionChecklist } from "~/components/admin/settings/UsersSettings";
import { togglePermissions } from "~/components/admin/settings/staff-access";
import type { AgentGrantSelection, AgentRisk } from "./types";

/** The opt-in scopes and the permissions each turns on (grant-scopes.ts). */
export const OPT_IN_SCOPES = [
  { key: "inbox", permissions: ["conversations.view", "conversations.reply"] },
  { key: "reviews", permissions: ["reviews.view", "reviews.moderate"] },
] as const;

const CEILINGS: readonly AgentRisk[] = ["read", "write", "destructive", "financial", "security"];

/** Keys that change things last 90 days at most; a look-only key a year (the API's limits). */
export function customMaxExpiryDays(risk: AgentRisk | undefined): number {
  return risk === "read" ? 365 : 90;
}

export default function CustomAccessFields({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentGrantSelection;
  onChange: (value: AgentGrantSelection) => void;
  disabled?: boolean;
}) {
  const t = useMessages(aiAccessMessages);
  const checked = new Set(value.permissions);
  const risk = value.riskCeiling ?? "write";
  const setPermissions = (next: Set<string>) => onChange({ ...value, permissions: [...next].sort() });
  return (
    <div className="space-y-4 border-t border-border pt-4">
      <fieldset className="space-y-3" disabled={disabled}>
        <legend className="mb-2 text-body font-medium">{t("optInTitle")}</legend>
        {OPT_IN_SCOPES.map((scope) => {
          const on = scope.permissions.every((permission) => checked.has(permission));
          const id = `ai-key-scope-${scope.key}`;
          return (
            <ChoiceField
              key={scope.key}
              id={id}
              label={t(scope.key === "inbox" ? "inboxScope" : "reviewsScope")}
              help={t(scope.key === "inbox" ? "inboxScopeHelp" : "reviewsScopeHelp")}
              control={(
                <Checkbox
                  id={id}
                  checked={on}
                  aria-describedby={`${id}-help`}
                  onCheckedChange={(next) => setPermissions(togglePermissions(checked, scope.permissions, next === true))}
                />
              )}
            />
          );
        })}
      </fieldset>

      <fieldset className="space-y-1" disabled={disabled} aria-describedby="ai-key-permissions-note">
        <legend className="text-body font-medium">{t("permissions")}</legend>
        <p id="ai-key-permissions-note" className={value.permissions.length ? "text-body text-muted-foreground" : "text-body text-destructive"}>
          {value.permissions.length ? t("permissionsHelp") : t("permissionsRequired")}
        </p>
        <div className="rounded-lg border border-border">
          <PermissionChecklist id="ai-key-permissions" checked={checked} disabled={disabled} onChange={setPermissions} />
        </div>
      </fieldset>

      <SettingsField id="ai-key-risk" label={t("riskCeiling")} help={t("riskCeilingHelp")}>
        <SearchableSelect
          id="ai-key-risk"
          value={risk}
          disabled={disabled}
          onValueChange={(next) => {
            const riskCeiling = next as AgentRisk;
            onChange({
              ...value,
              riskCeiling,
              expiresInDays: Math.min(value.expiresInDays, customMaxExpiryDays(riskCeiling)),
            });
          }}
          triggerClassName="w-full"
          options={CEILINGS.map((ceiling) => ({ value: ceiling, label: t(`ceiling_${ceiling}`) }))}
        />
      </SettingsField>

      {risk === "read" ? null : (
        <ChoiceField
          id="ai-key-confirm"
          label={t("confirmPolicy")}
          help={t("confirmPolicyHelp")}
          control={(
            <Checkbox
              id="ai-key-confirm"
              checked={value.confirmPolicy !== "none"}
              disabled={disabled}
              aria-describedby="ai-key-confirm-help"
              onCheckedChange={(next) => onChange({ ...value, confirmPolicy: next === true ? "destructive_financial" : "none" })}
            />
          )}
        />
      )}
    </div>
  );
}
