import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCw,
  Shield,
  Store,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";

import {
  getAgentConnection,
  listAgentAuditEvents,
  revokeAgentGrant,
  rotateAgentToken,
  updateAgentGrant,
} from "./api";
import { formatAgentAccessDate } from "./ConnectionTable";
import { toLocalDateTimeValue } from "./GrantSelectionFields";
import { OneTimeSecretDialog } from "./OneTimeSecretDialog";
import { RevokeDialog } from "./RevokeDialog";
import {
  permissionLabel,
  type AgentConnection,
  type AgentRisk,
} from "./types";

const RISKS: AgentRisk[] = [
  "read",
  "write",
  "destructive",
  "financial",
  "security",
];

function normalizeRisk(value: string): AgentRisk {
  return RISKS.includes(value as AgentRisk) ? (value as AgentRisk) : "read";
}

function DetailLine({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

interface NarrowAccessDialogProps {
  connection: AgentConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (connection: AgentConnection) => Promise<unknown> | unknown;
}

function NarrowAccessDialog({
  connection,
  open,
  onOpenChange,
  onSaved,
}: NarrowAccessDialogProps) {
  const [permissions, setPermissions] = useState<string[]>(connection.permissions);
  const [riskCeiling, setRiskCeiling] = useState<AgentRisk>(() =>
    normalizeRisk(connection.riskCeiling),
  );
  const [expiresAt, setExpiresAt] = useState(() =>
    toLocalDateTimeValue(new Date(connection.expiresAt)),
  );

  useEffect(() => {
    if (!open) return;
    setPermissions(connection.permissions);
    setRiskCeiling(normalizeRisk(connection.riskCeiling));
    setExpiresAt(toLocalDateTimeValue(new Date(connection.expiresAt)));
  }, [connection, open]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateAgentGrant(connection.id, {
        permissions: [...permissions].sort(),
        riskCeiling,
        expiresAt: new Date(expiresAt).toISOString(),
      }),
    onSuccess: async (updated) => {
      toast.success("Connection access narrowed");
      await onSaved(updated);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connection could not be updated"));
    },
  });

  const selected = new Set(permissions);
  const currentRiskIndex = RISKS.indexOf(normalizeRisk(connection.riskCeiling));
  const validExpiry = new Date(expiresAt).getTime();
  const canSave =
    permissions.length > 0 &&
    Number.isFinite(validExpiry) &&
    validExpiry > Date.now() &&
    validExpiry <= new Date(connection.expiresAt).getTime();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Narrow connection access</DialogTitle>
          <DialogDescription>
            Existing access can be removed or shortened. Expanding access requires
            a new connection and approval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label>Permissions</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {permissions.length} of {connection.permissions.length}
              </span>
            </div>
            <div className="grid max-h-64 gap-1 overflow-y-auto rounded-lg border bg-muted/15 p-2 sm:grid-cols-2">
              {[...connection.permissions].sort().map((permission) => (
                <Label
                  key={permission}
                  htmlFor={`narrow-${permission}`}
                  className="flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-xs hover:bg-muted"
                >
                  <Checkbox
                    id={`narrow-${permission}`}
                    checked={selected.has(permission)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked === true) next.add(permission);
                      else next.delete(permission);
                      setPermissions([...next].sort());
                    }}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{permissionLabel(permission)}</span>
                    <code className="block truncate text-[10px] text-muted-foreground">
                      {permission}
                    </code>
                  </span>
                </Label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="narrow-risk">Maximum action risk</Label>
            <Select
              value={riskCeiling}
              onValueChange={(value) => setRiskCeiling(value as AgentRisk)}
            >
              <SelectTrigger id="narrow-risk" className="min-h-11 sm:min-h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RISKS.slice(0, currentRiskIndex + 1).map((risk) => (
                  <SelectItem key={risk} value={risk}>
                    {permissionLabel(risk)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="narrow-expiry">Expires</Label>
            <Input
              id="narrow-expiry"
              type="datetime-local"
              value={expiresAt}
              min={toLocalDateTimeValue(new Date(Date.now() + 60_000))}
              max={toLocalDateTimeValue(new Date(connection.expiresAt))}
              onChange={(event) => setExpiresAt(event.currentTarget.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onOpenChange(false)}
            disabled={saveMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={!canSave || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Shield className="h-4 w-4" aria-hidden="true" />
            )}
            Save narrower access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConnectionDetailsProps {
  connection: AgentConnection | null;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<unknown> | unknown;
}

export function ConnectionDetails({
  connection,
  open,
  canManage,
  onOpenChange,
  onChanged,
}: ConnectionDetailsProps) {
  const queryClient = useQueryClient();
  const [auditPage, setAuditPage] = useState(1);
  const [editOpen, setEditOpen] = useState(false);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);

  useEffect(() => setAuditPage(1), [connection?.id]);

  const detailQuery = useQuery({
    queryKey: ["agent-access", "connection", connection?.id],
    queryFn: () => getAgentConnection(connection!.id),
    enabled: open && Boolean(connection),
    initialData: connection ?? undefined,
    staleTime: 15_000,
  });
  const current = detailQuery.data ?? connection;

  const auditQuery = useQuery({
    queryKey: ["agent-access", "events", connection?.id, auditPage],
    queryFn: () => listAgentAuditEvents(connection!.id, { page: auditPage, limit: 10 }),
    enabled: open && Boolean(connection),
    staleTime: 10_000,
  });

  const rotateMutation = useMutation({
    mutationFn: (credentialId: string) => rotateAgentToken(credentialId),
    onSuccess: async (result) => {
      setRotatedToken(result.token);
      queryClient.setQueryData(
        ["agent-access", "connection", connection?.id],
        result.connection,
      );
      toast.success("Token rotated");
      await onChanged();
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Token could not be rotated"));
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (reason: string) => revokeAgentGrant(connection!.id, reason),
    onSuccess: async () => {
      toast.success("Connection revoked");
      await onChanged();
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connection could not be revoked"));
    },
  });

  const permissions = useMemo(
    () => [...(current?.permissions ?? [])].sort(),
    [current?.permissions],
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-2xl">
          <div className="border-b px-4 py-4 sm:px-6">
            <SheetHeader className="pr-10 text-left">
              <div className="flex items-center gap-2">
                {current?.resource === "storefront" ? (
                  <Store className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Bot className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                )}
                <SheetTitle>{current?.label || current?.clientName || "Connection"}</SheetTitle>
              </div>
              <SheetDescription>
                Exact authority, credentials, and recent safe activity.
              </SheetDescription>
            </SheetHeader>
            <SheetClose asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-3 top-3"
                aria-label="Close connection details"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            {detailQuery.isPending || !current ? (
              <div className="space-y-3" role="status" aria-label="Loading connection">
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-48 w-full" />
              </div>
            ) : detailQuery.error ? (
              <Alert variant="destructive">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>Connection details are unavailable</AlertTitle>
                <AlertDescription>
                  Retry before changing this connection.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void detailQuery.refetch()}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-4">
                <Card className="shadow-none">
                  <CardHeader className="border-b p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm">Connection authority</CardTitle>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge variant={current.status === "active" ? "default" : "outline"}>
                          {current.status}
                        </Badge>
                        <Badge variant="outline">{current.resource}</Badge>
                        <Badge variant="secondary">{current.preset}</Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="divide-y p-4 pt-1">
                    <dl>
                      <DetailLine label="Owner">{current.ownerName ?? "Former admin"}</DetailLine>
                      <DetailLine label="Kind">{current.kind.toUpperCase()}</DetailLine>
                      {current.clientName ? (
                        <DetailLine label="Client">{current.clientName}</DetailLine>
                      ) : null}
                      {current.clientId ? (
                        <DetailLine label="Client ID">
                          <code className="text-xs">{current.clientId}</code>
                        </DetailLine>
                      ) : null}
                      <DetailLine label="Risk ceiling">{permissionLabel(current.riskCeiling)}</DetailLine>
                      <DetailLine label="Created">{formatAgentAccessDate(current.createdAt)}</DetailLine>
                      <DetailLine label="Expires">{formatAgentAccessDate(current.expiresAt)}</DetailLine>
                      <DetailLine label="Last used">{formatAgentAccessDate(current.lastUsedAt)}</DetailLine>
                      <DetailLine label="Last operation">
                        {current.lastOperationId ? (
                          <code className="text-xs">{current.lastOperationId}</code>
                        ) : (
                          "None"
                        )}
                      </DetailLine>
                    </dl>
                    <div className="pt-3">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 sm:min-h-9"
                          disabled={!canManage || current.status !== "active"}
                          onClick={() => setEditOpen(true)}
                        >
                          <Shield className="h-4 w-4" aria-hidden="true" />
                          Narrow access
                        </Button>
                        <RevokeDialog
                          title="Revoke this connection?"
                          description="Revocation takes effect on the next request. The agent must be approved again to reconnect."
                          confirmLabel="Revoke connection"
                          onConfirm={(reason) => revokeMutation.mutateAsync(reason)}
                          disabled={!canManage || current.status !== "active"}
                          pending={revokeMutation.isPending}
                          triggerVariant="destructive"
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="shadow-none">
                  <CardHeader className="border-b p-4">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Shield className="h-4 w-4" aria-hidden="true" />
                      Permission snapshot
                      <Badge variant="secondary" className="ml-auto">
                        {permissions.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap gap-1.5">
                      {permissions.map((permission) => (
                        <Badge key={permission} variant="outline" className="font-mono text-[10px]">
                          {permission}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {current.credentials.length > 0 ? (
                  <Card className="shadow-none">
                    <CardHeader className="border-b p-4">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <KeyRound className="h-4 w-4" aria-hidden="true" />
                        Credentials
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="divide-y p-0">
                      {current.credentials.map((credential) => (
                        <div
                          key={credential.id}
                          className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline">
                                {credential.kind.toUpperCase()}
                              </Badge>
                              <code className="truncate text-xs">
                                {credential.tokenHint}
                              </code>
                              {credential.revokedAt ? (
                                <Badge variant="secondary">revoked</Badge>
                              ) : null}
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Used {formatAgentAccessDate(credential.lastUsedAt)} ·
                              Expires {formatAgentAccessDate(credential.expiresAt)}
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="min-h-11 shrink-0 sm:min-h-9"
                            disabled={
                              !canManage ||
                              Boolean(credential.revokedAt) ||
                              rotateMutation.isPending ||
                              current.status !== "active"
                            }
                            onClick={() => rotateMutation.mutate(credential.id)}
                          >
                            {rotateMutation.isPending &&
                            rotateMutation.variables === credential.id ? (
                              <Loader2
                                className="h-4 w-4 animate-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <RotateCw className="h-4 w-4" aria-hidden="true" />
                            )}
                            Rotate
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ) : null}

                <Card className="shadow-none">
                  <CardHeader className="border-b p-4">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        <Activity className="h-4 w-4" aria-hidden="true" />
                        Recent activity
                      </CardTitle>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Refresh activity"
                        disabled={auditQuery.isFetching}
                        onClick={() => void auditQuery.refetch()}
                      >
                        <RefreshCw
                          className={`h-4 w-4 ${auditQuery.isFetching ? "animate-spin" : ""}`}
                          aria-hidden="true"
                        />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    {auditQuery.isPending ? (
                      <div className="space-y-2 p-4" role="status" aria-label="Loading activity">
                        <Skeleton className="h-14 w-full" />
                        <Skeleton className="h-14 w-full" />
                      </div>
                    ) : auditQuery.error ? (
                      <p role="alert" className="p-4 text-sm text-destructive">
                        Activity could not be loaded.
                      </p>
                    ) : auditQuery.data.events.length === 0 ? (
                      <p className="p-4 text-sm text-muted-foreground">No activity recorded.</p>
                    ) : (
                      <div className="divide-y">
                        {auditQuery.data.events.map((event) => (
                          <div key={event.id} className="flex items-start gap-3 p-4">
                            {event.outcome === "success" ? (
                              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                            ) : (
                              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <code className="truncate text-xs font-medium">
                                  {event.operationId ?? "connection.event"}
                                </code>
                                <Badge variant="outline" className="text-[10px]">{event.outcome}</Badge>
                              </div>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {permissionLabel(event.risk)} · {event.httpStatus ?? "—"} · {event.durationMs ?? "—"} ms · {formatAgentAccessDate(event.createdAt)}
                              </p>
                              {event.errorClass || event.requestId ? (
                                <p className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
                                  {event.errorClass ? (
                                    <span>Error: {event.errorClass}</span>
                                  ) : null}
                                  {event.requestId ? (
                                    <code>Request: {event.requestId}</code>
                                  ) : null}
                                </p>
                              ) : null}
                              {event.resourceIds.length > 0 ? (
                                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                                  Resources: {event.resourceIds.join(", ")}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {auditQuery.data && auditQuery.data.pagination.totalPages > 1 ? (
                      <div className="flex items-center justify-between border-t p-3">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={auditPage <= 1}
                          onClick={() => setAuditPage((page) => Math.max(1, page - 1))}
                        >
                          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                          Previous
                        </Button>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {auditPage} / {auditQuery.data.pagination.totalPages}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={auditPage >= auditQuery.data.pagination.totalPages}
                          onClick={() => setAuditPage((page) => page + 1)}
                        >
                          Next
                          <ChevronRight className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {current ? (
        <NarrowAccessDialog
          connection={current}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSaved={async (updated) => {
            queryClient.setQueryData(
              ["agent-access", "connection", updated.id],
              updated,
            );
            await onChanged();
          }}
        />
      ) : null}

      <OneTimeSecretDialog
        token={rotatedToken}
        title="Copy the replacement token now"
        onClose={() => setRotatedToken(null)}
      />
    </>
  );
}
