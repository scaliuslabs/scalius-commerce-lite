import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Edit3, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  createTaxClass,
  deleteTaxClass,
  updateTaxClass,
  type TaxClassRecord,
  type TaxConfigurationPayload,
} from "@/lib/api-functions/taxes";
import { getServerFnError } from "@/lib/api-helpers";
import { queryKeys } from "@/lib/query-keys";

interface ClassDraft {
  name: string;
  description: string;
  isExempt: boolean;
}

const EMPTY_DRAFT: ClassDraft = { name: "", description: "", isExempt: false };

export function TaxClassesPanel({
  configuration,
  canManage,
}: {
  configuration: TaxConfigurationPayload;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TaxClassRecord | null>(null);
  const [deleting, setDeleting] = useState<TaxClassRecord | null>(null);
  const [draft, setDraft] = useState<ClassDraft>(EMPTY_DRAFT);

  useEffect(() => {
    if (!editing) return;
    const current = configuration.classes.find((taxClass) => taxClass.id === editing.id);
    if (!current) {
      setEditing(null);
      setDraft(EMPTY_DRAFT);
    }
  }, [configuration.classes, editing]);

  const ratesByClass = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rate of configuration.rates) {
      counts.set(rate.taxClassId, (counts.get(rate.taxClassId) ?? 0) + 1);
    }
    return counts;
  }, [configuration.rates]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.settings.taxes() });
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      const update = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        isExempt: draft.isExempt,
      };
      return editing
        ? updateTaxClass({ data: {
            id: editing.id,
            expectedVersion: editing.version,
            update,
          } })
        : createTaxClass({ data: update });
    },
    onSuccess: async () => {
      toast.success(editing ? "Tax class updated" : "Tax class created");
      setEditing(null);
      setDraft(EMPTY_DRAFT);
      await refresh();
    },
    onError: (error) => toast.error(getServerFnError(error, "Tax class could not be saved.")),
  });
  const deleteMutation = useMutation({
    mutationFn: (taxClass: TaxClassRecord) => deleteTaxClass({ data: {
      id: taxClass.id,
      expectedVersion: taxClass.version,
    } }),
    onSuccess: async () => {
      toast.success("Tax class deleted");
      setDeleting(null);
      await refresh();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Tax class is still in use or changed in another tab."));
      setDeleting(null);
    },
  });

  const beginEdit = (taxClass: TaxClassRecord) => {
    setEditing(taxClass);
    setDraft({
      name: taxClass.name,
      description: taxClass.description ?? "",
      isExempt: taxClass.isExempt,
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <Card className="min-w-0 h-fit">
        <CardHeader>
          <CardTitle>{editing ? "Edit class" : "Create a class"}</CardTitle>
          <CardDescription>
            Classes group products and SKUs under merchant-defined tax treatment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tax-class-name">Name</Label>
            <Input
              className="min-h-11 md:min-h-9"
              id="tax-class-name"
              value={draft.name}
              maxLength={120}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Standard goods"
              disabled={!canManage}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax-class-description">Internal description</Label>
            <Textarea
              id="tax-class-description"
              value={draft.description}
              maxLength={500}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="Where this class should be applied"
              disabled={!canManage}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
            <div>
              <Label htmlFor="tax-class-exempt">Exempt class</Label>
              <p className="mt-1 text-xs text-muted-foreground">Always produces zero tax.</p>
            </div>
            <Switch
              className="relative after:absolute after:-inset-x-1.5 after:-inset-y-3"
              id="tax-class-exempt"
              checked={draft.isExempt}
              disabled={!canManage}
              onCheckedChange={(isExempt) => setDraft((current) => ({ ...current, isExempt }))}
            />
          </div>
          <div className="flex gap-2">
            <Button
              className="min-h-11 flex-1 md:min-h-10"
              disabled={!canManage || !draft.name.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? <Edit3 className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
              {editing ? "Save changes" : "Create class"}
            </Button>
            {editing ? (
              <Button
                variant="outline"
                size="icon"
                className="h-11 w-11 md:h-10 md:w-10"
                aria-label="Cancel editing"
                onClick={() => {
                  setEditing(null);
                  setDraft(EMPTY_DRAFT);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle>Tax classes</CardTitle>
          <CardDescription>
            A class cannot be deleted while settings, rates, products, or SKUs reference it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {configuration.classes.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              Create the first class before enabling tax.
            </div>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {configuration.classes.map((taxClass) => (
                  <article key={taxClass.id} className="space-y-3 rounded-xl border p-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{taxClass.name}</h3>
                        {taxClass.isExempt ? (
                          <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3" /> Exempt</Badge>
                        ) : (
                          <Badge variant="outline">Taxable</Badge>
                        )}
                      </div>
                      <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                        {taxClass.description || "No description"}
                      </p>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Saved rates</span>
                      <span className="font-medium">{ratesByClass.get(taxClass.id) ?? 0}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button className="min-h-11" variant="outline" disabled={!canManage} aria-label={`Edit ${taxClass.name}`} onClick={() => beginEdit(taxClass)}>
                        <Edit3 className="h-4 w-4" /> Edit
                      </Button>
                      <Button className="min-h-11" variant="outline" disabled={!canManage} aria-label={`Delete ${taxClass.name}`} onClick={() => setDeleting(taxClass)}>
                        <Trash2 className="h-4 w-4" /> Delete
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Class</TableHead>
                      <TableHead>Treatment</TableHead>
                      <TableHead>Rates</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {configuration.classes.map((taxClass) => (
                      <TableRow key={taxClass.id}>
                        <TableCell>
                          <div className="font-medium">{taxClass.name}</div>
                          <div className="max-w-md truncate text-xs text-muted-foreground">
                            {taxClass.description || "No description"}
                          </div>
                        </TableCell>
                        <TableCell>
                          {taxClass.isExempt ? (
                            <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3" /> Exempt</Badge>
                          ) : (
                            <Badge variant="outline">Taxable</Badge>
                          )}
                        </TableCell>
                        <TableCell>{ratesByClass.get(taxClass.id) ?? 0}</TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" disabled={!canManage} aria-label={`Edit ${taxClass.name}`} onClick={() => beginEdit(taxClass)}>
                              <Edit3 className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" disabled={!canManage} aria-label={`Delete ${taxClass.name}`} onClick={() => setDeleting(taxClass)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes the class only if no saved rule or catalog item still uses it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting)}
              disabled={deleteMutation.isPending}
            >
              Delete class
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
