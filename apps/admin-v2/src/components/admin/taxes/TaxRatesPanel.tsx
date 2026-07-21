import { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Edit3, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  createTaxRate,
  deleteTaxRate,
  updateTaxRate,
  type TaxConfigurationPayload,
  type TaxJurisdictionType,
  type TaxRateRecord,
} from "@/lib/api-functions/taxes";
import { getServerFnError } from "@/lib/api-helpers";
import { queryKeys } from "@/lib/query-keys";
import {
  basisPointsToPercent,
  percentToBasisPoints,
  resolveJurisdictionSelection,
} from "./tax-form";
import { getTaxRateDraftOverlap } from "./tax-rate-diagnostics";
import { TaxRateDiagnosticsPanel } from "./TaxRateDiagnosticsPanel";
import { getRequiredTaxRateRoles } from "./tax-readiness";

interface RateDraft {
  taxClassId: string;
  name: string;
  percent: string;
  jurisdictionType: TaxJurisdictionType;
  jurisdictionId: string;
  priority: string;
  isCompound: boolean;
  isActive: boolean;
}

const EMPTY_DRAFT: RateDraft = {
  taxClassId: "",
  name: "",
  percent: "",
  jurisdictionType: "all",
  jurisdictionId: "",
  priority: "0",
  isCompound: false,
  isActive: true,
};

export function TaxRatesPanel({
  configuration,
  canManage,
  onOpenClasses,
  onOpenPreview,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
  onOpenClasses: () => void;
  onOpenPreview: () => void;
}) {
  const queryClient = useQueryClient();
  const rateNameRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<TaxRateRecord | null>(null);
  const [deleting, setDeleting] = useState<TaxRateRecord | null>(null);
  const [draft, setDraft] = useState<RateDraft>(EMPTY_DRAFT);
  const availableJurisdictions = useMemo(
    () => configuration.jurisdictions.filter((option) => option.type === draft.jurisdictionType),
    [configuration.jurisdictions, draft.jurisdictionType],
  );
  const jurisdictionOptions = useMemo(
    () => availableJurisdictions.map((option) => ({
      value: option.id,
      label: option.name,
    })),
    [availableJurisdictions],
  );
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
  const deletingRequiredRoles = getRequiredTaxRateRoles(configuration, deleting);
  const removesRequiredCoverage = Boolean(
    editing && editingRequiredRoles.length > 0 && (
      !draft.isActive || draft.taxClassId !== editing.taxClassId
    ),
  );
  const canSave = Boolean(
    draft.taxClassId &&
    draft.name.trim() &&
    parsedRateBps !== null &&
    parsedPriority >= 0 &&
    parsedPriority <= 1000 &&
    jurisdiction &&
    !removesRequiredCoverage,
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
  };
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
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      await refresh();
    },
    onError: (error) => toast.error(getServerFnError(error, "Tax rate could not be saved.")),
  });
  const deleteMutation = useMutation({
    mutationFn: (rate: TaxRateRecord) => deleteTaxRate({ data: {
      id: rate.id,
      expectedVersion: rate.version,
    } }),
    onSuccess: async () => {
      toast.success("Tax rate deleted");
      setDeleting(null);
      await refresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax rate changed in another tab."));
      setDeleting(null);
    },
  });

  const beginEdit = (rate: TaxRateRecord) => {
    setEditing(rate);
    setDraft({
      taxClassId: rate.taxClassId,
      name: rate.name,
      percent: basisPointsToPercent(rate.rateBps),
      jurisdictionType: rate.jurisdictionType,
      jurisdictionId: rate.jurisdictionId ?? "",
      priority: String(rate.priority),
      isCompound: rate.isCompound,
      isActive: rate.isActive,
    });
    requestAnimationFrame(() => rateNameRef.current?.focus());
  };

  const beginBroadRate = (taxClassId: string) => {
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT, taxClassId });
    requestAnimationFrame(() => rateNameRef.current?.focus());
  };

  const className = (id: string) =>
    configuration.classes.find((taxClass) => taxClass.id === id)?.name ?? "Unknown class";

  return (
    <div className="space-y-6">
      <TaxRateDiagnosticsPanel
        configuration={configuration}
        canManage={canManage}
        onAddBroadRate={beginBroadRate}
        onOpenClasses={onOpenClasses}
        onReviewRate={(rateId) => {
          const rate = configuration.rates.find((candidate) => candidate.id === rateId);
          if (rate) beginEdit(rate);
        }}
        onOpenPreview={onOpenPreview}
      />

      <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit min-w-0">
          <CardHeader>
            <CardTitle>{editing ? "Edit rate" : "Create a rate"}</CardTitle>
            <CardDescription>Rates that match the same checkout are added together. Use priority and compound only when you intentionally layer rates.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Tax class</Label>
              <Select value={draft.taxClassId} disabled={!canManage} onValueChange={(taxClassId) => setDraft((current) => ({ ...current, taxClassId }))}>
                <SelectTrigger className="min-h-11 md:min-h-9" aria-label="Tax class"><SelectValue placeholder="Choose a class" /></SelectTrigger>
                <SelectContent>
                  {configuration.classes.map((taxClass) => (
                    <SelectItem key={taxClass.id} value={taxClass.id}>{taxClass.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tax-rate-name">Rate name</Label>
              <Input className="min-h-11 md:min-h-9" ref={rateNameRef} id="tax-rate-name" value={draft.name} maxLength={120} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Dhaka standard" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="tax-rate-percent">Rate (%)</Label>
                <Input className="min-h-11 md:min-h-9" id="tax-rate-percent" inputMode="decimal" value={draft.percent} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, percent: event.target.value }))} placeholder="15.00" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tax-rate-priority">Priority (advanced)</Label>
                <Input className="min-h-11 md:min-h-9" id="tax-rate-priority" inputMode="numeric" value={draft.priority} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Jurisdiction</Label>
              <Select
                value={draft.jurisdictionType}
                disabled={!canManage}
                onValueChange={(value) => setDraft((current) => ({
                  ...current,
                  jurisdictionType: value as TaxJurisdictionType,
                  jurisdictionId: "",
                }))}
              >
                <SelectTrigger className="min-h-11 md:min-h-9" aria-label="Jurisdiction type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All destinations</SelectItem>
                  <SelectItem value="city">City</SelectItem>
                  <SelectItem value="zone">Zone</SelectItem>
                  <SelectItem value="area">Area</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.jurisdictionType !== "all" ? (
              <div className="space-y-2">
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
                  <p className="text-xs text-destructive">Add an active {draft.jurisdictionType} under Checkout → Delivery Locations first.</p>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleField label="Active" checked={draft.isActive} disabled={!canManage} onCheckedChange={(isActive) => setDraft((current) => ({ ...current, isActive }))} />
              <ToggleField label="Compound" checked={draft.isCompound} disabled={!canManage} onCheckedChange={(isCompound) => setDraft((current) => ({ ...current, isCompound }))} />
            </div>
            {draftOverlap ? (
              <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{draftOverlap.detail}</p>
              </div>
            ) : null}
            {removesRequiredCoverage ? (
              <p role="alert" className="text-xs leading-5 text-destructive">
                This is the only active rate for {editingRequiredRoles.join(" and ")}. Add a replacement rate before deactivating it or moving it to another class.
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button className="min-h-11 flex-1 md:min-h-10" disabled={!canManage || !canSave || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Edit3 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editing ? "Save rate" : "Create rate"}
              </Button>
              {editing ? (
                <Button className="h-11 w-11 md:h-10 md:w-10" variant="outline" size="icon" aria-label="Cancel editing" onClick={() => { setEditing(null); setDraft(EMPTY_DRAFT); }}>
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Saved rates</CardTitle>
            <CardDescription>{configuration.rates.length} merchant-defined rule{configuration.rates.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent>
            {configuration.rates.length === 0 ? (
              <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No rates have been saved.</div>
            ) : (
              <>
                <div className="space-y-2 md:hidden">
                  {configuration.rates.map((rate) => (
                    <article key={rate.id} className="space-y-3 rounded-xl border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="break-words font-medium">{rate.name} · {basisPointsToPercent(rate.rateBps)}%</h3>
                          <p className="mt-1 text-xs text-muted-foreground">{className(rate.taxClassId)}{rate.isCompound ? " · Compound" : ""}</p>
                        </div>
                        <Badge variant={rate.isActive ? "default" : "secondary"}>{rate.isActive ? "Active" : "Inactive"}</Badge>
                      </div>
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div className="min-w-0">
                          <dt className="text-xs text-muted-foreground">Scope</dt>
                          <dd className="mt-1 break-words font-medium">{rate.jurisdictionType === "all" ? "All destinations" : rate.jurisdictionLabel ?? rate.jurisdictionType}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Priority</dt>
                          <dd className="mt-1 font-medium">{rate.priority}</dd>
                        </div>
                      </dl>
                      <div className="grid grid-cols-2 gap-2">
                        <Button className="min-h-11" variant="outline" disabled={!canManage} aria-label={`Edit ${rate.name}`} onClick={() => beginEdit(rate)}><Edit3 className="h-4 w-4" /> Edit</Button>
                        <Button className="min-h-11" variant="outline" disabled={!canManage} aria-label={`Delete ${rate.name}`} onClick={() => setDeleting(rate)}><Trash2 className="h-4 w-4" /> Delete</Button>
                      </div>
                    </article>
                  ))}
                </div>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader><TableRow><TableHead>Rate</TableHead><TableHead>Scope</TableHead><TableHead>Priority</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {configuration.rates.map((rate) => (
                        <TableRow key={rate.id}>
                          <TableCell>
                            <div className="font-medium">{rate.name} · {basisPointsToPercent(rate.rateBps)}%</div>
                            <div className="text-xs text-muted-foreground">{className(rate.taxClassId)}{rate.isCompound ? " · compound" : ""}</div>
                          </TableCell>
                          <TableCell>{rate.jurisdictionType === "all" ? "All destinations" : rate.jurisdictionLabel ?? rate.jurisdictionType}</TableCell>
                          <TableCell>{rate.priority}</TableCell>
                          <TableCell><Badge variant={rate.isActive ? "default" : "secondary"}>{rate.isActive ? "Active" : "Inactive"}</Badge></TableCell>
                          <TableCell><div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" disabled={!canManage} aria-label={`Edit ${rate.name}`} onClick={() => beginEdit(rate)}><Edit3 className="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" disabled={!canManage} aria-label={`Delete ${rate.name}`} onClick={() => setDeleting(rate)}><Trash2 className="h-4 w-4" /></Button>
                          </div></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingRequiredRoles.length > 0
                ? `This is the only active rate for ${deletingRequiredRoles.join(" and ")}. Add a replacement before deleting it while tax calculation is enabled.`
                : "The rule will stop participating in future quotes. Existing order tax snapshots do not change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending || deletingRequiredRoles.length > 0}
              onClick={() => deleting && deletingRequiredRoles.length === 0 && deleteMutation.mutate(deleting)}
            >
              Delete rate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ToggleField({ label, checked, disabled, onCheckedChange }: { label: string; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between rounded-xl border p-3"><Label>{label}</Label><Switch className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={label} /></div>;
}
