import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

import { AccessFields, defaultSelection } from "./AccessFields";
import {
  countClearableAgentConnections,
  createAgentToken,
  listAgentConnections,
  purgeRevokedAgentConnections,
  revokeAgentGrant,
  revokeAllAgentGrants,
} from "./api";
import type { AgentConnection } from "./types";

const LIST_LIMIT = 100;

/** Active connections plus how many old ones "Clear old connections" would remove. */
export const aiAccessQuery = {
  queryKey: ["agent-access", "card"] as const,
  queryFn: async () => {
    const [page, clearable] = await Promise.all([
      listAgentConnections({ page: 1, limit: LIST_LIMIT, status: "active" }),
      countClearableAgentConnections(),
    ]);
    return { connections: page.connections, total: page.pagination.total, clearable: clearable.total };
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

function ConnectionRow({ connection, canManage }: { connection: AgentConnection; canManage: boolean }) {
  const t = useMessages(aiAccessMessages);
  const common = useMessages(settingsMessages);
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const name = connection.label || connection.clientName || t("unnamed");
  const lastUsed = formatDate(connection.lastUsedAt, true);
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
    save: async () => {
      try {
        const result = await createAgentToken({ ...selection, label: name.trim() });
        onCreated(result.token);
      } catch (error) {
        toast.error(t("createFailed"));
        throw error;
      }
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
  // Creating and removing access is reserved for Super Admins who hold the permission.
  const canManage = isSuperAdmin && permissions.has(ADMIN_PERMISSIONS.AGENT_ACCESS_MANAGE);
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
                <ConnectionRow key={connection.id} connection={connection} canManage={canManage} />
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
