import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Edit3, Loader2, Plus, Scale, Trash2, X } from "lucide-react";
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
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TaxRateRecord | null>(null);
  const [deleting, setDeleting] = useState<TaxRateRecord | null>(null);
  const [draft, setDraft] = useState<RateDraft>(EMPTY_DRAFT);
  const availableJurisdictions = useMemo(
    () => configuration.jurisdictions.filter((option) => option.type === draft.jurisdictionType),
    [configuration.jurisdictions, draft.jurisdictionType],
  );
  const parsedRateBps = percentToBasisPoints(draft.percent);
  const parsedPriority = /^\d{1,4}$/.test(draft.priority) ? Number(draft.priority) : -1;
  const jurisdiction = resolveJurisdictionSelection(
    draft.jurisdictionType,
    draft.jurisdictionId,
    configuration.jurisdictions,
  );
  const canSave = Boolean(
    draft.taxClassId &&
    draft.name.trim() &&
    parsedRateBps !== null &&
    parsedPriority >= 0 &&
    parsedPriority <= 1000 &&
    jurisdiction,
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
  };

  const className = (id: string) =>
    configuration.classes.find((taxClass) => taxClass.id === id)?.name ?? "Unknown class";

  return (
    <div className="space-y-6">
      <Card className="border-amber-500/25 bg-amber-500/[0.04]">
        <CardContent className="flex gap-3 pt-6 text-sm text-muted-foreground">
          <Scale className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <p>
            Enter only rates your business has verified for the selected jurisdiction. The platform stores and calculates your rules; it does not provide tax or legal advice.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{editing ? "Edit rate" : "Create a rate"}</CardTitle>
            <CardDescription>Priority runs low to high. Compound rates include earlier priority tax in their base.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Tax class</Label>
              <Select value={draft.taxClassId} disabled={!canManage} onValueChange={(taxClassId) => setDraft((current) => ({ ...current, taxClassId }))}>
                <SelectTrigger><SelectValue placeholder="Choose a class" /></SelectTrigger>
                <SelectContent>
                  {configuration.classes.map((taxClass) => (
                    <SelectItem key={taxClass.id} value={taxClass.id}>{taxClass.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tax-rate-name">Rate name</Label>
              <Input id="tax-rate-name" value={draft.name} maxLength={120} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Dhaka standard" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="tax-rate-percent">Rate (%)</Label>
                <Input id="tax-rate-percent" inputMode="decimal" value={draft.percent} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, percent: event.target.value }))} placeholder="15.00" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tax-rate-priority">Priority</Label>
                <Input id="tax-rate-priority" inputMode="numeric" value={draft.priority} disabled={!canManage} onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))} />
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
                <SelectTrigger><SelectValue /></SelectTrigger>
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
                <Label>Saved destination</Label>
                <Select value={draft.jurisdictionId} disabled={!canManage} onValueChange={(jurisdictionId) => setDraft((current) => ({ ...current, jurisdictionId }))}>
                  <SelectTrigger><SelectValue placeholder={`Choose ${draft.jurisdictionType}`} /></SelectTrigger>
                  <SelectContent>
                    {availableJurisdictions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availableJurisdictions.length === 0 ? (
                  <p className="text-xs text-destructive">Add an active {draft.jurisdictionType} under Checkout → Delivery Locations first.</p>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleField label="Active" checked={draft.isActive} disabled={!canManage} onCheckedChange={(isActive) => setDraft((current) => ({ ...current, isActive }))} />
              <ToggleField label="Compound" checked={draft.isCompound} disabled={!canManage} onCheckedChange={(isCompound) => setDraft((current) => ({ ...current, isCompound }))} />
            </div>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!canManage || !canSave || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Edit3 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {editing ? "Save rate" : "Create rate"}
              </Button>
              {editing ? (
                <Button variant="outline" size="icon" aria-label="Cancel editing" onClick={() => { setEditing(null); setDraft(EMPTY_DRAFT); }}>
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Saved rates</CardTitle>
            <CardDescription>{configuration.rates.length} merchant-defined rule{configuration.rates.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent>
            {configuration.rates.length === 0 ? (
              <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No rates have been saved.</div>
            ) : (
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
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle><AlertDialogDescription>The rule will stop participating in future quotes. Existing order tax snapshots do not change.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction disabled={deleteMutation.isPending} onClick={() => deleting && deleteMutation.mutate(deleting)}>Delete rate</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ToggleField({ label, checked, disabled, onCheckedChange }: { label: string; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between rounded-xl border p-3"><Label>{label}</Label><Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={label} /></div>;
}
