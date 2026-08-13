import { ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";

import {
  AGENT_PRESETS,
  permissionLabel,
  type AgentPreset,
} from "./types";

interface PermissionSelectorProps {
  preset: AgentPreset;
  permissions: string[];
  availablePermissions: string[];
  onPresetChange: (preset: AgentPreset) => void;
  onPermissionsChange: (permissions: string[]) => void;
  disabled?: boolean;
}
export function PermissionSelector({
  preset,
  permissions,
  availablePermissions,
  onPresetChange,
  onPermissionsChange,
  disabled = false,
}: PermissionSelectorProps) {
  const selected = new Set(permissions);
  const sortedPermissions = [...availablePermissions].sort((left, right) =>
    left.localeCompare(right),
  );

  const togglePermission = (permission: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(permission);
    else next.delete(permission);
    onPermissionsChange([...next].sort());
  };

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">Access preset</legend>
      <RadioGroup
        value={preset}
        onValueChange={(value) => onPresetChange(value as AgentPreset)}
        className="grid gap-2 sm:grid-cols-2"
        aria-label="Access preset"
      >
        {AGENT_PRESETS.map((option) => (
          <Label
            key={option.id}
            htmlFor={`agent-preset-${option.id}`}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 ${
              preset === option.id
                ? "border-primary bg-primary/[0.04] ring-1 ring-primary/20"
                : ""
            }`}
          >
            <RadioGroupItem
              id={`agent-preset-${option.id}`}
              value={option.id}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-5">
                {option.label}
              </span>
              <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                {option.description}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      {preset === "full" ? (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Full Super Admin authority</AlertTitle>
          <AlertDescription className="text-amber-900/80 dark:text-amber-100/75">
            This connection can change money, security, integrations, store data,
            and other agent connections within your live authority.
          </AlertDescription>
        </Alert>
      ) : null}

      {preset === "custom" ? (
        <div className="rounded-lg border bg-muted/15 p-3">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Exact permissions</p>
              <p className="text-xs text-muted-foreground">
                The connection keeps this immutable snapshot.
              </p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {selected.size} selected
            </span>
          </div>
          {sortedPermissions.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No permissions are available for this account.
            </p>
          ) : (
            <div className="grid max-h-64 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
              {sortedPermissions.map((permission) => (
                <Label
                  key={permission}
                  htmlFor={`agent-permission-${permission}`}
                  className="flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted"
                >
                  <Checkbox
                    id={`agent-permission-${permission}`}
                    checked={selected.has(permission)}
                    onCheckedChange={(value) =>
                      togglePermission(permission, value === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {permissionLabel(permission)}
                    </span>
                    <code className="block truncate text-[10px] font-normal text-muted-foreground">
                      {permission}
                    </code>
                  </span>
                </Label>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
