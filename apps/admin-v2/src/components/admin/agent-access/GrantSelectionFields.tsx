import { Bot, Store } from "lucide-react";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { PermissionSelector } from "./PermissionSelector";
import {
  AGENT_RESOURCE_COPY,
  type AgentGrantSelection,
  type AgentPreset,
  type AgentResource,
  type AgentRisk,
} from "./types";

interface GrantSelectionFieldsProps {
  value: AgentGrantSelection;
  availablePermissions: string[];
  onChange: (value: AgentGrantSelection) => void;
  resourceLocked?: boolean;
  disabled?: boolean;
  maxExpiryDays?: number;
}

export function GrantSelectionFields({
  value,
  availablePermissions,
  onChange,
  resourceLocked = false,
  disabled = false,
  maxExpiryDays = value.preset === "read" ? 365 : 90,
}: GrantSelectionFieldsProps) {
  const setPreset = (preset: AgentPreset) => {
    const riskCeiling: AgentRisk =
      preset === "read" ? "read" : preset === "operator" ? "write" : "security";
    onChange({
      ...value,
      preset,
      permissions: preset === "custom" ? value.permissions : [],
      riskCeiling: preset === "custom" ? value.riskCeiling ?? "read" : riskCeiling,
      expiresInDays: Math.min(
        value.expiresInDays,
        preset === "read" ? maxExpiryDays : Math.min(maxExpiryDays, 90),
      ),
    });
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled || resourceLocked}>
        <legend className="text-sm font-medium">Resource</legend>
        <RadioGroup
          value={value.resource}
          onValueChange={(resource) =>
            onChange({ ...value, resource: resource as AgentResource })
          }
          className="grid grid-cols-2 gap-2"
          aria-label="Agent resource"
        >
          {(["dashboard", "storefront"] as const).map((resource) => {
            const copy = AGENT_RESOURCE_COPY[resource];
            const Icon = resource === "dashboard" ? Bot : Store;
            return (
              <Label
                key={resource}
                htmlFor={`agent-resource-${resource}`}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${
                  value.resource === resource
                    ? "border-primary bg-primary/[0.04] ring-1 ring-primary/20"
                    : ""
                } ${resourceLocked ? "cursor-default" : "hover:bg-muted/40"}`}
              >
                <RadioGroupItem
                  id={`agent-resource-${resource}`}
                  value={resource}
                  className="mt-0.5"
                />
                <span>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {copy.label}
                  </span>
                  <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                    {copy.description}
                  </span>
                </span>
              </Label>
            );
          })}
        </RadioGroup>
      </fieldset>

      <PermissionSelector
        preset={value.preset}
        permissions={value.permissions}
        availablePermissions={availablePermissions}
        onPresetChange={setPreset}
        onPermissionsChange={(permissions) =>
          onChange({ ...value, permissions })
        }
        disabled={disabled}
      />

      {value.preset === "custom" ? (
        <div className="space-y-1.5">
          <Label htmlFor="agent-risk-ceiling">Maximum action risk</Label>
          <Select
            value={value.riskCeiling ?? "read"}
            onValueChange={(riskCeiling) =>
              onChange({ ...value, riskCeiling: riskCeiling as AgentRisk })
            }
            disabled={disabled}
          >
            <SelectTrigger id="agent-risk-ceiling" className="min-h-11 sm:min-h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">Read</SelectItem>
              <SelectItem value="write">Write</SelectItem>
              <SelectItem value="destructive">Destructive</SelectItem>
              <SelectItem value="financial">Financial</SelectItem>
              <SelectItem value="security">Security</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Permissions and this ceiling both have to allow an operation.
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="agent-grant-expiry">Lifetime in days</Label>
        <Input
          id="agent-grant-expiry"
          type="number"
          inputMode="numeric"
          value={value.expiresInDays}
          min={1}
          max={maxExpiryDays}
          onChange={(event) =>
            onChange({
              ...value,
              expiresInDays: Number.parseInt(event.currentTarget.value, 10) || 1,
            })
          }
          disabled={disabled}
          required
        />
        <p className="text-xs text-muted-foreground">
          Between 1 and {maxExpiryDays} days. Short-lived access limits the
          impact of a forgotten connection.
        </p>
      </div>
    </div>
  );
}

export function toLocalDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function defaultGrantSelection(
  resource: AgentResource = "dashboard",
  preset: AgentPreset = "read",
  expiresInDays = 90,
): AgentGrantSelection {
  return {
    resource,
    preset,
    permissions: [],
    riskCeiling:
      preset === "read" ? "read" : preset === "operator" ? "write" : "security",
    expiresInDays,
  };
}
