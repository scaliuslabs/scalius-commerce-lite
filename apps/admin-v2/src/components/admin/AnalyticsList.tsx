import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  Code2,
  Edit3,
  Gauge,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { formatDate } from "@scalius/shared/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { AdminListPagination } from "./shared/AdminListPagination";
import { usePermissions } from "@/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import {
  useDeleteAnalyticsScript,
  usePermanentDeleteAnalyticsScript,
  useRestoreAnalyticsScript,
  useToggleAnalyticsScript,
} from "@/lib/api-mutations/analytics";
import type {
  AnalyticsScriptSummary,
  PaginationResponse,
} from "~/types/api-responses";
import { cn } from "@scalius/shared/utils";

interface AnalyticsListProps {
  scripts: AnalyticsScriptSummary[];
  pagination: PaginationResponse;
  showTrashed: boolean;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  google_analytics: "Google Analytics 4",
  google_tag_manager: "Google Tag Manager",
  facebook_pixel: "Meta Pixel",
  tiktok_pixel: "TikTok Pixel",
  cloudflare_web_analytics: "Cloudflare Web Analytics",
  custom: "Custom code",
};

const LOCATION_LABELS: Record<string, string> = {
  head: "Document head",
  body_start: "Body start",
  body_end: "Body end",
};

function readinessPresentation(script: AnalyticsScriptSummary) {
  if (script.readiness === "ready") return {
    label: "Live",
    icon: CircleCheck,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  };
  if (script.readiness === "ready_to_activate") return {
    label: "Ready to activate",
    icon: Power,
    className: "border-sky-200 bg-sky-50 text-sky-700",
  };
  if (script.readiness === "blocked") return {
    label: "Needs attention",
    icon: CircleAlert,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  };
  if (script.readiness === "trashed") return {
    label: "In trash",
    icon: Trash2,
    className: "border-muted bg-muted text-muted-foreground",
  };
  return {
    label: "Draft",
    icon: Gauge,
    className: "border-amber-200 bg-amber-50 text-amber-800",
  };
}

export function AnalyticsList({
  scripts,
  pagination,
  showTrashed,
  onPageChange,
  onLimitChange,
}: AnalyticsListProps) {
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const canToggle = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_TOGGLE);
  const deleteMutation = useDeleteAnalyticsScript();
  const permanentDeleteMutation = usePermanentDeleteAnalyticsScript();
  const restoreMutation = useRestoreAnalyticsScript();
  const toggleMutation = useToggleAnalyticsScript();
  const [deleteTarget, setDeleteTarget] = useState<AnalyticsScriptSummary | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<AnalyticsScriptSummary | null>(null);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  const isMutating = deleteMutation.isPending || permanentDeleteMutation.isPending;

  if (scripts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-6 py-12 text-center">
        <Activity className="mx-auto h-8 w-8 text-muted-foreground/60" />
        <h2 className="mt-3 text-sm font-semibold">
          {showTrashed ? "Analytics trash is empty" : "No matching analytics scripts"}
        </h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {showTrashed
            ? "Scripts moved to trash stay recoverable here."
            : "Create a draft or change the filters to see another provider."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/35 hover:bg-muted/35">
              <TableHead>Integration</TableHead>
              <TableHead>Delivery</TableHead>
              <TableHead>Readiness</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-[156px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scripts.map((script) => {
              const presentation = readinessPresentation(script);
              const ReadinessIcon = presentation.icon;
              return (
                <TableRow key={script.id} className="group">
                  <TableCell className="py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-muted/30">
                        {script.type === "custom" ? (
                          <Code2 className="h-4 w-4" />
                        ) : (
                          <Activity className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{script.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {PROVIDER_LABELS[script.type] ?? script.type}
                          {script.identifier ? (
                            <span className="font-mono"> · {script.identifier}</span>
                          ) : null}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <p className="text-sm">{LOCATION_LABELS[script.location] ?? script.location}</p>
                    <p className="text-xs text-muted-foreground">
                      {script.usePartytown ? "Worker isolated" : "Main thread"}
                    </p>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <Badge
                      variant="outline"
                      className={cn("gap-1.5 whitespace-nowrap", presentation.className)}
                      title={script.configIssue ?? presentation.label}
                    >
                      <ReadinessIcon className="h-3.5 w-3.5" />
                      {presentation.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2.5 text-sm text-muted-foreground">
                    <span suppressHydrationWarning>{formatDate(script.updatedAt)}</span>
                  </TableCell>
                  <TableCell className="py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {showTrashed ? (
                        canEdit ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Restore ${script.name}`}
                              title="Restore as inactive"
                              onClick={() => restoreMutation.mutate({
                                id: script.id,
                                expectedRevision: script.revision,
                              })}
                            >
                              <ArchiveRestore className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              aria-label={`Permanently delete ${script.name}`}
                              title="Delete permanently"
                              onClick={() => setDeleteTarget(script)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        ) : null
                      ) : (
                        <>
                          {canToggle && script.isActive ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Deactivate ${script.name}`}
                              title="Deactivate"
                              onClick={() => toggleMutation.mutate({
                                id: script.id,
                                expectedRevision: script.revision,
                                isActive: false,
                              })}
                            >
                              <PowerOff className="h-4 w-4" />
                            </Button>
                          ) : null}
                          {canToggle && !script.isActive && script.readiness === "ready_to_activate" ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Activate ${script.name}`}
                              title="Activate"
                              onClick={() => setDuplicateTarget(script)}
                            >
                              <Power className="h-4 w-4" />
                            </Button>
                          ) : null}
                          {canEdit ? (
                            <Button variant="ghost" size="icon" asChild>
                              <Link
                                to="/admin/analytics/$analyticsId/edit"
                                params={{ analyticsId: script.id }}
                                aria-label={`Edit ${script.name}`}
                                title="Edit"
                              >
                                <Edit3 className="h-4 w-4" />
                              </Link>
                            </Button>
                          ) : null}
                          {canEdit ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              aria-label={`Move ${script.name} to trash`}
                              title="Move to trash"
                              onClick={() => setDeleteTarget(script)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <AdminListPagination
        pagination={pagination}
        itemLabel="scripts"
        onPageChange={onPageChange}
        onLimitChange={onLimitChange}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {showTrashed ? "Delete analytics script permanently?" : "Move analytics script to trash?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {showTrashed
                ? "This removes the saved source permanently. This action cannot be undone."
                : "The script will stop loading immediately and can be restored later as an inactive draft."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isMutating}
              onClick={() => {
                if (!deleteTarget) return;
                const claim = {
                  id: deleteTarget.id,
                  expectedRevision: deleteTarget.revision,
                };
                if (showTrashed) permanentDeleteMutation.mutate(claim);
                else deleteMutation.mutate(claim);
                setDeleteTarget(null);
              }}
            >
              {isMutating ? "Working…" : showTrashed ? "Delete permanently" : "Move to trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={duplicateTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDuplicateTarget(null);
            setDuplicateConfirmed(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate this analytics script?</AlertDialogTitle>
            <AlertDialogDescription>
              It will begin loading on buyer pages after the layout cache refreshes. If another script for the same provider is active, duplicate page views can distort reports.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <Checkbox
              checked={duplicateConfirmed}
              onCheckedChange={(checked) => setDuplicateConfirmed(checked === true)}
            />
            <span>I understand and allow a second active script for this provider if one already exists.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!duplicateTarget) return;
                toggleMutation.mutate({
                  id: duplicateTarget.id,
                  expectedRevision: duplicateTarget.revision,
                  isActive: true,
                  allowDuplicateProvider: duplicateConfirmed,
                });
                setDuplicateTarget(null);
                setDuplicateConfirmed(false);
              }}
            >
              Activate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
