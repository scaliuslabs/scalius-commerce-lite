import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { PermissionName } from "@scalius/core/auth/rbac/types";

import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useSaveBar } from "~/components/admin/shared/SaveBar";
import { SettingsLoadFailure } from "~/components/admin/settings/SettingsLoadFailure";
import {
  SettingsCard,
  SettingsCardLoading,
  SettingsDialog,
  SettingsField,
  SettingsRow,
} from "~/components/admin/settings/SettingsPage";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { usePermissions } from "~/contexts/PermissionContext";
import { formatDateTime, useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { permissionMessages } from "~/i18n/settings-users";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

import { AccessFields, defaultSelection } from "./AccessFields";
import {
  countClearableAgentConnections,
  createAgentToken,
  listAgentConnectionEvents,
  listAgentConnections,
  purgeRevokedAgentConnections,
  revokeAgentGrant,
  revokeAllAgentGrants,
  rotateAgentCredential,
} from "./api";
import type { AgentAuditEvent, AgentConnection, AgentRisk } from "./types";

const LIST_LIMIT = 100;
const ACTIVITY_LIMIT = 10;
const RISKS: ReadonlySet<string> = new Set<AgentRisk>(["read", "write", "destructive", "financial", "security"]);

/** Active connections plus how many old ones "Clear old connections" would remove. */
export const aiAccessQuery = {
  queryKey: ["agent-access", "card"] as const,
  queryFn: async () => {
    const [page, clearable] = await Promise.all([
      listAgentConnections({ page: 1, limit: LIST_LIMIT, status: "active" }),
      countClearableAgentConnections(),
    ]);
    return {
      connections: page.connections,
      total: page.pagination.total,
      clearable: clearable.total,
      // The server's verdict on this session (store owner, two-step verified).
      canManage: page.canManage === true,
    };
  },
};

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["agent-access"] });
}

function formatDate(value: string | null, withTime = false): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTime(date, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

const isKnownPermission = (permission: string): permission is PermissionName =>
  Object.hasOwn(permissionMessages.en, permission);

/** What the connection may do: the preset's plain summary, or each custom permission. */
function ConnectionAbilities({ connection }: { connection: AgentConnection }) {
  const t = useMessages(aiAccessMessages);
  const label = useMessages(permissionMessages);
  const permissions = connection.permissions ?? [];
  const known = permissions.filter(isKnownPermission);
  const unknown = permissions.length - known.length;
  return (
    <section className="space-y-1">
      <h3 className="text-heading-sm">{t("whatItCanDo")}</h3>
      {connection.preset !== "custom" ? (
        <p className="text-body text-muted-foreground">{t(`preset_${connection.preset}Help`)}</p>
      ) : permissions.length === 0 ? (
        <p className="text-body text-muted-foreground">{t("noPermissions")}</p>
      ) : (
        <ul className="space-y-1 text-body">
          {known.map((permission) => (
            <li key={permission}>{label(permission)}</li>
          ))}
          {unknown > 0 ? (
            <li className="text-muted-foreground">{t("morePermissions", { count: unknown })}</li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function ActivityLine({ event }: { event: AgentAuditEvent }) {
  const t = useMessages(aiAccessMessages);
  const when = formatDate(event.createdAt, true);
  return (
    <li className="flex min-h-11 items-center justify-between gap-4 py-2 text-body">
      <span className="flex flex-wrap items-center gap-2">
        {RISKS.has(event.risk) ? t(`risk_${event.risk}`) : t("risk_other")}
        {event.outcome === "denied" ? <Badge variant="warning">{t("outcome_denied")}</Badge> : null}
        {event.outcome === "failed" ? <Badge variant="destructive">{t("outcome_failed")}</Badge> : null}
      </span>
      {when ? <span className="shrink-0 text-muted-foreground">{when}</span> : null}
    </li>
  );
}

/** The newest events for one connection, fetched only while its dialog is open. */
function RecentActivity({ grantId, open }: { grantId: string; open: boolean }) {
  const t = useMessages(aiAccessMessages);
  const common = useMessages(settingsMessages);
  const { data, isError, isRefetching, refetch } = useQuery({
    queryKey: ["agent-access", "events", grantId],
    queryFn: () => listAgentConnectionEvents(grantId, { page: 1, limit: ACTIVITY_LIMIT }),
    enabled: open,
  });
  let body: ReactNode;
  if (isError) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body text-destructive">{t("activityFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>
          {common("retry")}
        </Button>
      </div>
    );
  } else if (!data) {
    body = (
      <p className="flex items-center gap-2 text-body text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t("activityLoading")}
      </p>
    );
  } else if (data.events.length === 0) {
    body = <p className="text-body text-muted-foreground">{t("noActivity")}</p>;
  } else {
    body = (
      <ul className="divide-y divide-border">
        {data.events.map((event) => (
          <ActivityLine key={event.id} event={event} />
        ))}
      </ul>
    );
  }
  return (
    <section className="space-y-1">
      <h3 className="text-heading-sm">{t("recentActivity")}</h3>
      {body}
    </section>
  );
}

function ConnectionRow({
  connection,
  canManage,
  onNewKey,
}: {
  connection: AgentConnection;
  canManage: boolean;
  onNewKey: (key: string) => void;
}) {
  const t = useMessages(aiAccessMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const name = connection.label || connection.clientName || t("unnamed");
  const lastUsed = formatDate(connection.lastUsedAt, true);
  // Only pasted keys can be replaced; an AI assistant reconnects instead.
  const activeKey =
    connection.kind === "pat" || connection.kind === "cli"
      ? connection.credentials?.find((credential) => credential.revokedAt === null)
      : undefined;
  const replace = useMutation({
    // The new key goes straight to component state; the mutation keeps nothing.
    mutationFn: async (credentialId: string) => {
      const result = await rotateAgentCredential(credentialId);
      onNewKey(result.token);
    },
    onSuccess: async () => {
      setConfirmReplace(false);
      setOpen(false);
      await refresh();
    },
    onError: () => toast.error(t("replaceFailed")),
  });
  const disconnect = useMutation({
    mutationFn: () => revokeAgentGrant(connection.id),
    onSuccess: async () => {
      toast.success(t("disconnected"));
      setOpen(false);
      await refresh();
    },
    onError: () => toast.error(t("disconnectFailed")),
  });
  const details: Array<[string, string]> = [
    [t("type"), t(`kind_${connection.kind}`)],
    [t("access"), t(`preset_${connection.preset}`)],
    [t("worksWith"), t(`resource_${connection.resource}`)],
    [t("addedBy"), connection.ownerName ?? t("formerStaff")],
    [t("added"), formatDate(connection.createdAt) ?? t("never")],
    [t("lastUsedLabel"), lastUsed ?? t("never")],
    [t("expires"), formatDate(connection.expiresAt) ?? t("never")],
  ];
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <SettingsRow
            label={name}
            value={t("rowValue", {
              kind: t(`kind_${connection.kind}`),
              used: lastUsed ? t("lastUsed", { date: lastUsed }) : t("neverUsed"),
            })}
          />
        </DialogTrigger>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
          </DialogHeader>
          <dl className="divide-y divide-border">
            {details.map(([label, value]) => (
              <div key={label} className="flex min-h-11 items-center justify-between gap-4 py-2 text-body">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
          <ConnectionAbilities connection={connection} />
          <RecentActivity grantId={connection.id} open={open} />
          {canManage && activeKey ? (
            <div>
              <Button type="button" variant="outline" onClick={() => setConfirmReplace(true)}>
                {t("replaceKey")}
              </Button>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("close")}
            </Button>
            {canManage ? (
              <Button type="button" variant="destructive" onClick={() => setConfirm(true)}>
                {t("disconnect")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("disconnectTitle", { name })}
        description={t("disconnectBody")}
        confirmLabel={t("disconnect")}
        cancelLabel={common("cancel")}
        loadingLabel={t("working")}
        isLoading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
      <ConfirmDialog
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title={t("replaceTitle", { name })}
        description={t("replaceBody")}
        confirmLabel={t("replaceKey")}
        cancelLabel={common("cancel")}
        loadingLabel={t("working")}
        isLoading={replace.isPending}
        onConfirm={() => {
          if (activeKey) replace.mutate(activeKey.id);
        }}
      />
    </>
  );
}

/**
 * Name + access for a new key. The key itself goes straight to `onCreated`
 * (component state), never into the query or mutation cache.
 */
function CreateKeyForm({ onCreated }: { onCreated: (key: string) => void }) {
  const t = useMessages(aiAccessMessages);
  const [name, setName] = useState("");
  const [selection, setSelection] = useState(() => defaultSelection("pat"));
  useSaveBar({
    dirty: name.trim().length > 0,
    // A failure is listed in the dialog's banner; the form keeps its values.
    save: async () => {
      const result = await createAgentToken({ ...selection, label: name.trim() });
      onCreated(result.token);
    },
    discard: () => {
      setName("");
      setSelection(defaultSelection("pat"));
    },
  });
  return (
    <>
      <SettingsField id="ai-key-name" label={t("name")} help={t("nameHelp")}>
        <Input
          id="ai-key-name"
          value={name}
          maxLength={80}
          autoComplete="off"
          placeholder={t("namePlaceholder")}
          aria-describedby="ai-key-name-note"
          onChange={(event) => setName(event.target.value)}
        />
      </SettingsField>
      <AccessFields kind="pat" value={selection} onChange={setSelection} />
    </>
  );
}

/** Shows a new key once. Closing it drops the key from the page. */
function NewKeyDialog({ keyValue, onClose }: { keyValue: string | null; onClose: () => void }) {
  const t = useMessages(aiAccessMessages);
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onClose();
  };
  async function copy() {
    if (!keyValue) return;
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopied(true);
      toast.success(t("keyCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  return (
    <Dialog open={keyValue !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        className="sm:max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("keyTitle")}</DialogTitle>
          <DialogDescription>{t("keyDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            readOnly
            value={keyValue ?? ""}
            aria-label={t("keyLabel")}
            className="min-w-0 flex-1"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" variant="outline" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Apps: apps and AI assistants with access to the store. */
export function AiAccessCard() {
  const t = useMessages(aiAccessMessages);
  const common = useMessages(settingsMessages);
  const { hasPermission, isSuperAdmin, permissions } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.AGENT_ACCESS_VIEW);
  // Creating and removing access is reserved for Super Admins who hold the permission,
  // in a session that passed two-step verification (the server decides that part).
  const mayManage = isSuperAdmin && permissions.has(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE);
  const refresh = useRefresh();
  const { data, isPending, isError, refetch } = useQuery({ ...aiAccessQuery, enabled: canView });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOld, setConfirmOld] = useState(false);

  const disconnectAll = useMutation({
    mutationFn: () => revokeAllAgentGrants(),
    onSuccess: async () => {
      toast.success(t("disconnectedAll"));
      await refresh();
    },
    onError: () => toast.error(t("disconnectFailed")),
  });
  const clearOld = useMutation({
    mutationFn: () => purgeRevokedAgentConnections(),
    onSuccess: async () => {
      toast.success(t("cleared"));
      await refresh();
    },
    onError: () => toast.error(common("saveFailed")),
  });

  if (!canView) return null;
  if (isPending) return <SettingsCardLoading />;
  if (isError) return <SettingsLoadFailure title={t("title")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const { connections, total, clearable } = data;
  const canManage = mayManage && data.canManage;
  const needsTwoStep = mayManage && !data.canManage;
  const quietActions = canManage && (connections.length > 0 || clearable > 0);
  return (
    <>
      <SettingsCard id="aiAccess"
        title={t("title")}
        description={t("description")}
        action={
          canManage ? (
            <SettingsDialog
              title={t("createKey")}
              description={t("createKeyDescription")}
              trigger={<Button type="button" variant="outline" size="sm">{t("createKey")}</Button>}
            >
              <CreateKeyForm
                onCreated={(key) => {
                  setNewKey(key);
                  void refresh();
                }}
              />
            </SettingsDialog>
          ) : null
        }
        rows={
          connections.length || quietActions ? (
            <>
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  canManage={canManage}
                  onNewKey={setNewKey}
                />
              ))}
              {quietActions ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 first:border-t-0">
                  {connections.length ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>
                      {t("disconnectAll")}
                    </Button>
                  ) : null}
                  {clearable > 0 ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOld(true)}>
                      {t("clearOld", { count: clearable })}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null
        }
      >
        {needsTwoStep ? (
          <Alert variant="warning" role="status">
            <ShieldAlert aria-hidden="true" />
            <AlertDescription>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p>{t("twoStepNeeded")}</p>
                <Button asChild variant="outline" size="sm">
                  <Link to="/admin/account" hash="two-step">{t("twoStepAction")}</Link>
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        {connections.length === 0 || total > connections.length ? (
          <p className="text-body text-muted-foreground">
            {connections.length === 0 ? t("empty") : t("showing", { shown: connections.length, total })}
          </p>
        ) : null}
      </SettingsCard>
      <NewKeyDialog keyValue={newKey} onClose={() => setNewKey(null)} />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t("disconnectAllTitle")}
        description={t("disconnectAllBody")}
        confirmLabel={t("disconnectAll")}
        cancelLabel={common("cancel")}
        loadingLabel={t("working")}
        isLoading={disconnectAll.isPending}
        onConfirm={() => disconnectAll.mutate()}
      />
      <ConfirmDialog
        open={confirmOld}
        onOpenChange={setConfirmOld}
        title={t("clearOldTitle")}
        description={t("clearOldBody", { count: clearable })}
        confirmLabel={t("clear")}
        cancelLabel={common("cancel")}
        loadingLabel={t("working")}
        isLoading={clearOld.isPending}
        onConfirm={() => clearOld.mutate()}
      />
    </>
  );
}
