import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { EditorSheet } from "~/components/admin/shell/EditorSheet";
import { FieldError } from "~/components/admin/shell/FieldError";
import { InlineHelp } from "~/components/admin/shell/InlineHelp";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  createTaxRate,
  updateTaxRate,
  type TaxConfigurationPayload,
  type TaxJurisdictionType,
  type TaxRateRecord,
} from "~/lib/api-functions/taxes";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import {
  percentToBasisPoints,
  basisPointsToPercent,
  resolveJurisdictionSelection,
} from "./tax-form";
import { getTaxRateDraftOverlap } from "./tax-rate-diagnostics";
import { getRequiredTaxRateRoles } from "./tax-readiness";

export interface RateDraft {
  taxClassId: string;
  name: string;
  percent: string;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId: string;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

export const EMPTY_RATE_DRAFT: RateDraft = {
  taxClassId: "",
  name: "",
  percent: "",
  jurisdictionType: "all",
  jurisdictionId: "",
  priority: "0",
  isCompound: false,
  isActive: true,
};

export interface RateDraftIssues {
  taxClassId?: string;
  name?: string;
  percent?: string;
  priority?: string;
  jurisdictionId?: string;
}

/**
 * Field-level validation for the rate editor. D1 re-checks every submitted
 * mutation; this only keeps an obviously invalid draft from being sent.
 */
export function rateDraftIssues(draft: RateDraft): RateDraftIssues {
  const issues: RateDraftIssues = {};
  if (!draft.taxClassId) {
    issues.taxClassId = "Choose the class this rate applies to.";
  }
  if (!draft.name.trim()) {
    issues.name = "Enter a name that identifies this rate in the list.";
  }
  if (percentToBasisPoints(draft.percent) === null) {
    issues.percent = "Enter a percentage from 0 to 100, with up to two decimals.";
  }
  const priority = /^\d{1,4}$/.test(draft.priority) ? Number(draft.priority) : -1;
  if (priority < 0 || priority > 1000) {
    issues.priority = "Enter a whole number from 0 to 1000.";
  }
  if (draft.jurisdictionType !== "all" && !draft.jurisdictionId) {
    issues.jurisdictionId = "Choose a saved destination for this scope.";
  }
  return issues;
}

function rateDraftFromRecord(rate: TaxRateRecord): RateDraft {
  return {
    taxClassId: rate.taxClassId,
    name: rate.name,
    percent: basisPointsToPercent(rate.rateBps),
    jurisdictionType: rate.jurisdictionType,
    jurisdictionId: rate.jurisdictionId ?? "",
    priority: String(rate.priority),
    isCompound: rate.isCompound,
    isActive: rate.isActive,
  };
}

export function TaxRateFormSheet({
  open,
  onOpenChange,
  configuration,
  canManage,
  editing,
  initialTaxClassId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  /** The saved rate being edited, or null when creating one. */
  editing: TaxRateRecord | null;
  /** Pre-selected class when the editor opens from a coverage gap. */
  initialTaxClassId?: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RateDraft>(EMPTY_RATE_DRAFT);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setDraft(
      editing
        ? rateDraftFromRecord(editing)
        : { ...EMPTY_RATE_DRAFT, taxClassId: initialTaxClassId ?? "" },
    );
  }, [editing, initialTaxClassId, open]);

  const availableJurisdictions = useMemo(
    () => configuration.jurisdictions.filter(
      (option) => option.type === draft.jurisdictionType,
    ),
    [configuration.jurisdictions, draft.jurisdictionType],
  );
  const jurisdictionOptions = useMemo(
    () => availableJurisdictions.map((option) => ({
      value: option.id,
      label: option.name,
    })),
    [availableJurisdictions],
  );

  const issues = rateDraftIssues(draft);
  const parsedRateBps = percentToBasisPoints(draft.percent);
  const parsedPriority = /^\d{1,4}$/.test(draft.priority) ? Number(draft.priority) : -1;
  const jurisdiction = resolveJurisdictionSelection(
    draft.jurisdictionType,
    draft.jurisdictionId,
    configuration.jurisdictions,
  );
  const draftOverlap = jurisdiction && parsedPriority >= 0
    ? getTaxRateDraftOverlap(configuration, {
        taxClassId: draft.taxClassId,
        jurisdictionType: draft.jurisdictionType,
        jurisdictionId: jurisdiction.jurisdictionId,
        priority: parsedPriority,
        isActive: draft.isActive,
      }, editing?.id ?? null)
    : null;
  const editingRequiredRoles = getRequiredTaxRateRoles(configuration, editing);
  const removesRequiredCoverage = Boolean(
    editing && editingRequiredRoles.length > 0 && (
      !draft.isActive || draft.taxClassId !== editing.taxClassId
    ),
  );
  const hasFieldIssue = Object.keys(issues).length > 0;
  const canSave = Boolean(
    !hasFieldIssue
    && parsedRateBps !== null
    && jurisdiction
    && !removesRequiredCoverage,
  );
  const showIssue = (field: keyof RateDraftIssues) =>
    submitted ? issues[field] : undefined;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (parsedRateBps === null || !jurisdiction) {
        throw new Error("Enter a valid percentage and choose a saved destination.");
      }
      const update = {
        taxClassId: draft.taxClassId,
        name: draft.name.trim(),
        rateBps: parsedRateBps,
        jurisdictionType: draft.jurisdictionType,
        jurisdictionId: jurisdiction.jurisdictionId,
        jurisdictionLabel: jurisdiction.jurisdictionLabel,
        priority: parsedPriority,
        isCompound: draft.isCompound,
        isActive: draft.isActive,
      };
      return editing
        ? updateTaxRate({ data: {
            id: editing.id,
            expectedVersion: editing.version,
            update,
          } })
        : createTaxRate({ data: update });
    },
    onSuccess: async () => {
      toast.success(editing ? "Tax rate updated" : "Tax rate created");
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
    },
    onError: (error) => toast.error(getServerFnError(error, "Tax rate could not be saved.")),
  });

  function submit() {
    setSubmitted(true);
    if (!canSave) return;
    saveMutation.mutate();
  }

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      width="md"
      title={editing ? "Edit tax rate" : "Add tax rate"}
      description="Rates that match the same checkout are added together. Use priority and compound only when you intend to layer rates."
      onSubmit={submit}
      footer={(
        <>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            disabled={saveMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            className="min-h-11 sm:min-h-9 sm:min-w-32"
            disabled={!canManage || saveMutation.isPending || (submitted && !canSave)}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {editing ? "Save rate" : "Add rate"}
          </Button>
        </>
      )}
    >
      <div className="space-y-1.5">
        <Label htmlFor="tax-rate-class">Tax class</Label>
        <Select
          value={draft.taxClassId}
          disabled={!canManage}
          onValueChange={(taxClassId) => setDraft((current) => ({ ...current, taxClassId }))}
        >
          <SelectTrigger
            id="tax-rate-class"
            className="min-h-11 sm:min-h-9"
            aria-label="Tax class"
            aria-invalid={showIssue("taxClassId") ? true : undefined}
          >
            <SelectValue placeholder="Choose a class" />
          </SelectTrigger>
          <SelectContent>
            {configuration.classes.map((taxClass) => (
              <SelectItem key={taxClass.id} value={taxClass.id} className="min-h-11 sm:min-h-9">
                {taxClass.name}{taxClass.isExempt ? " · exempt" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError>{showIssue("taxClassId")}</FieldError>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tax-rate-name">Rate name</Label>
        <Input
          className="min-h-11 sm:min-h-9"
          id="tax-rate-name"
          value={draft.name}
          maxLength={120}
          disabled={!canManage}
          aria-invalid={showIssue("name") ? true : undefined}
          aria-describedby="tax-rate-name-help"
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="Dhaka standard"
        />
        <InlineHelp id="tax-rate-name-help">
          Shown in the rates list and in the calculation preview.
        </InlineHelp>
        <FieldError>{showIssue("name")}</FieldError>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tax-rate-percent">Rate (%)</Label>
          <Input
            className="min-h-11 sm:min-h-9"
            id="tax-rate-percent"
            inputMode="decimal"
            value={draft.percent}
            disabled={!canManage}
            aria-invalid={showIssue("percent") ? true : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, percent: event.target.value }))}
            placeholder="15.00"
          />
          <FieldError>{showIssue("percent")}</FieldError>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tax-rate-priority">Priority</Label>
          <Input
            className="min-h-11 sm:min-h-9"
            id="tax-rate-priority"
            inputMode="numeric"
            value={draft.priority}
            disabled={!canManage}
            aria-invalid={showIssue("priority") ? true : undefined}
            aria-describedby="tax-rate-priority-help"
            onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))}
          />
          <InlineHelp id="tax-rate-priority-help">
            Lower numbers are applied first when rates layer.
          </InlineHelp>
          <FieldError>{showIssue("priority")}</FieldError>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="tax-rate-scope">Destination</Label>
        <Select
          value={draft.jurisdictionType}
          disabled={!canManage}
          onValueChange={(value) => setDraft((current) => ({
            ...current,
            jurisdictionType: value as TaxJurisdictionType,
            jurisdictionId: "",
          }))}
        >
          <SelectTrigger id="tax-rate-scope" className="min-h-11 sm:min-h-9" aria-label="Jurisdiction type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="min-h-11 sm:min-h-9">All destinations</SelectItem>
            <SelectItem value="city" className="min-h-11 sm:min-h-9">City</SelectItem>
            <SelectItem value="zone" className="min-h-11 sm:min-h-9">Zone</SelectItem>
            <SelectItem value="area" className="min-h-11 sm:min-h-9">Area</SelectItem>
          </SelectContent>
        </Select>
        <InlineHelp id="tax-rate-scope-help">
          Destinations outside the saved scope receive zero tax for this class.
        </InlineHelp>
      </div>

      {draft.jurisdictionType !== "all" ? (
        <div className="space-y-1.5">
          <Label htmlFor="tax-rate-jurisdiction">Saved destination</Label>
          <SearchableSelect
            id="tax-rate-jurisdiction"
            value={draft.jurisdictionId}
            options={jurisdictionOptions}
            disabled={!canManage}
            onValueChange={(jurisdictionId) => setDraft((current) => ({ ...current, jurisdictionId }))}
            placeholder={`Choose ${draft.jurisdictionType}`}
            searchPlaceholder={`Search ${draft.jurisdictionType === "city" ? "cities" : `${draft.jurisdictionType}s`}…`}
            emptyMessage={`No matching ${draft.jurisdictionType}.`}
            ariaLabel={`Saved ${draft.jurisdictionType}`}
            required
            maxVisibleOptions={100}
            triggerClassName="w-full"
          />
          {availableJurisdictions.length === 0 ? (
            <FieldError>
              Add an active {draft.jurisdictionType} under Checkout → Delivery
              Locations first.
            </FieldError>
          ) : (
            <FieldError>{showIssue("jurisdictionId")}</FieldError>
          )}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <ToggleField
          id="tax-rate-active"
          label="Active"
          help="Inactive rates stay saved but never match a checkout."
          checked={draft.isActive}
          disabled={!canManage}
          onCheckedChange={(isActive) => setDraft((current) => ({ ...current, isActive }))}
        />
        <ToggleField
          id="tax-rate-compound"
          label="Compound"
          help="Applies on top of the tax already added by lower priorities."
          checked={draft.isCompound}
          disabled={!canManage}
          onCheckedChange={(isCompound) => setDraft((current) => ({ ...current, isCompound }))}
        />
      </div>

      {draftOverlap ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{draftOverlap.detail}</p>
        </div>
      ) : null}

      {removesRequiredCoverage ? (
        <FieldError>
          This is the only active rate for {editingRequiredRoles.join(" and ")}.
          Add a replacement rate before deactivating it or moving it to another
          class.
        </FieldError>
      ) : null}
    </EditorSheet>
  );
}

function ToggleField({
  id,
  label,
  help,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Switch
          className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      </div>
      <InlineHelp className="mt-1">{help}</InlineHelp>
    </div>
  );
}

export default TaxRateFormSheet;
