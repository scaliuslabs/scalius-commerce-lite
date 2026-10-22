import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Waypoints } from "lucide-react";
import {
  deleteApiV1AdminUrlRedirectsById,
  getApiV1AdminUrlRedirects,
  postApiV1AdminUrlRedirects,
} from "@scalius/api-client/sdk";
import { toast } from "~/lib/toast";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldGroup } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { DataTable } from "~/components/admin/data-table/DataTable";
import { useStaticTable } from "~/components/admin/data-table/use-static-table";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { EmptyState } from "~/components/admin/states";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData, type ApiResult } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { resourceMessages } from "~/i18n/resource";
import { OnlineStorePage } from "./shared";

type UrlRedirect = ApiResult<typeof getApiV1AdminUrlRedirects>["redirects"][number];
const QUERY_KEY = ["url-redirects"] as const;

/**
 * Online store › Navigation › URL redirects (Shopify's "URL redirects"): old
 * store addresses that lead to new ones. A product's URL handle change adds
 * one by itself; merchants add others (a removed page, a printed link) and
 * delete any. The storefront follows one only when the old address is gone.
 */
export function UrlRedirectsPage() {
  const t = useMessages(onlineStoreMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiData(getApiV1AdminUrlRedirects({ query: {} })),
  });
  const rows = useMemo(() => list.data?.redirects ?? [], [list.data]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<UrlRedirect | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => apiData(deleteApiV1AdminUrlRedirectsById({ path: { id } })),
    onSuccess: () => {
      toast.success(t("redirectDeleted"));
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(getServerFnError(error, t("redirectDeleteFailed"))),
  });

  const columns = useMemo<ColumnDef<UrlRedirect, unknown>[]>(() => [
    {
      id: "from",
      header: t("redirectFrom"),
      meta: { primary: true, minWidth: 220, maxWidth: 420 },
      cell: ({ row }) => <span className="block truncate font-mono" title={row.original.fromPath}>{row.original.fromPath}</span>,
    },
    {
      id: "to",
      header: t("redirectTo"),
      meta: { minWidth: 220, maxWidth: 420, priority: 90 },
      cell: ({ row }) => <span className="block truncate font-mono" title={row.original.toPath}>{row.original.toPath}</span>,
    },
    { id: "created", header: t("redirectAddedOn"), meta: { priority: 60, minWidth: 140 }, cell: ({ row }) => <ListDate value={row.original.createdAt} /> },
    {
      id: "actions",
      header: () => <span className="sr-only">{r("actions")}</span>,
      meta: { keep: true, minWidth: 56 },
      cell: ({ row }) => (
        <Button variant="ghost" size="icon-sm" aria-label={t("redirectDeleteNamed", { path: row.original.fromPath })} title={t("redirectDelete")} onClick={() => setDeleting(row.original)}>
          <Trash2 aria-hidden="true" />
        </Button>
      ),
    },
  ], [r, t]);
  const { table } = useStaticTable(rows, columns);
  const nothingYet = !list.isPending && !list.isError && rows.length === 0;
  const add = <Button onClick={() => setCreating(true)}><Plus aria-hidden="true" /> {t("redirectCreate")}</Button>;

  return (
    <OnlineStorePage title={t("redirectsTitle")} back={{ to: "/admin/online-store/navigation", label: t("navigationTitle") }} actions={nothingYet ? null : add}>
      <p className="text-body text-muted-foreground">{t("redirectsHelp")}</p>
      {nothingYet ? (
        <EmptyState icon={Waypoints} title={t("redirectsEmptyTitle")} description={t("redirectsEmptyBody")} action={add} />
      ) : (
        <>
          {list.data?.truncated ? <Alert><AlertDescription>{t("redirectsTruncated")}</AlertDescription></Alert> : null}
          <DataTable
            variant="card"
            table={table}
            isLoading={list.isPending}
            isFetching={list.isFetching}
            error={list.isError ? list.error : undefined}
            onRetry={() => void list.refetch()}
            what={t("redirectsTitle")}
            layoutKey="url-redirects"
            defaultSortLabel={false}
          />
        </>
      )}
      <CreateRedirectDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t("redirectDeleteTitle", { path: deleting?.fromPath ?? "" })}
        description={t("redirectDeleteBody")}
        confirmLabel={t("redirectDelete")}
        cancelLabel={r("cancel")}
        loadingLabel={r("working")}
        isLoading={remove.isPending}
        onConfirm={() => { if (deleting) remove.mutate(deleting.id); }}
      />
    </OnlineStorePage>
  );
}

function CreateRedirectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(onlineStoreMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const [fromPath, setFromPath] = useState("");
  const [toPath, setToPath] = useState("");
  const create = useMutation({
    mutationFn: () => apiData(postApiV1AdminUrlRedirects({ body: { fromPath, toPath } })),
    onSuccess: () => {
      toast.success(t("redirectAdded"));
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setFromPath("");
      setToPath("");
      onOpenChange(false);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!create.isPending) { create.reset(); onOpenChange(next); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("redirectCreate")}</DialogTitle>
          <DialogDescription>{t("redirectCreateHelp")}</DialogDescription>
        </DialogHeader>
        <form id="create-url-redirect" onSubmit={submit}>
          <FieldGroup>
            <Field id="redirect-from" label={t("redirectFrom")}>
              <Input id="redirect-from" value={fromPath} required autoComplete="off" autoCapitalize="none" placeholder="/products/old-name" onChange={(event) => setFromPath(event.target.value)} />
            </Field>
            <Field id="redirect-to" label={t("redirectTo")}>
              <Input id="redirect-to" value={toPath} required autoComplete="off" autoCapitalize="none" placeholder="/products/new-name" onChange={(event) => setToPath(event.target.value)} />
            </Field>
            {create.isError ? <p role="alert" className="text-body text-destructive">{getServerFnError(create.error, t("redirectCreateFailed"))}</p> : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
          <Button type="submit" form="create-url-redirect" loading={create.isPending} disabled={!fromPath.trim() || !toPath.trim()}>{t("redirectSave")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
