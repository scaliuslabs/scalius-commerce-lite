import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminAttributesByIdValues,
  postApiV1AdminAttributesByIdValues,
  putApiV1AdminAttributesByIdValues,
} from "@scalius/api-client/sdk";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { AdminListPagination } from "~/components/admin/shared/AdminListPagination";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDebounce } from "~/hooks/use-debounce";
import { formatNumber, useMessages } from "~/i18n";
import { attributeValueMessages } from "~/i18n/attributes";
import { apiData } from "~/lib/api";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { attributeValuesQueryOptions } from "~/lib/api-query-options/attributes";
import { queryKeys } from "~/lib/query-keys";
import type { AttributeValue, AttributeValuesViewerProps } from "../types";

const PAGE_SIZE = 20;

/**
 * An attribute's values: search, and (unless `readOnly`) add, rename and
 * delete. A rename or delete reaches every product using the value, so each
 * command runs alone and the dialog stays until the list has refreshed.
 */
export function AttributeValueEditor({
  attributeId,
  attributeName,
  onClose,
  openerRef,
  readOnly = false,
}: AttributeValuesViewerProps & { readOnly?: boolean }) {
  const t = useMessages(attributeValueMessages);
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [editingValue, setEditingValue] = useState<string | null>(null);
  const [editedValue, setEditedValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [savingValue, setSavingValue] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const commandInFlight = useRef(false);
  const openerAttributeId = useRef<string | null>(null);
  const debouncedSearch = useDebounce(searchQuery.trim(), 300);
  const pending = savingValue !== null;

  useEffect(() => {
    if (attributeId) openerAttributeId.current = attributeId;
    setSearchQuery("");
    setPage(1);
  }, [attributeId]);

  const valuesQuery = useQuery({
    ...attributeValuesQueryOptions({
      attributeId: attributeId ?? undefined,
      page,
      limit: PAGE_SIZE,
      search: debouncedSearch || undefined,
    }),
    enabled: Boolean(attributeId),
  });
  const values: AttributeValue[] = valuesQuery.data?.values ?? [];
  const isLoading = Boolean(attributeId) && valuesQuery.isPending;

  useEffect(() => {
    const totalPages = valuesQuery.data?.totalPages ?? 0;
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, valuesQuery.data?.totalPages]);

  /**
   * Runs one write at a time and keeps the dialog busy until the list shows its result.
   * `value` names the value a conflict is about ("Cotton already exists").
   */
  async function run(key: string, write: () => Promise<unknown>, success: string, failure: string, done: () => void, value?: string) {
    if (commandInFlight.current || !attributeId) return;
    commandInFlight.current = true;
    setSavingValue(key);
    try {
      await write();
      toast.success(success);
      done();
      await queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all }, { throwOnError: false });
    } catch (error: unknown) {
      toast.error(value && isAdminApiConflictError(error) ? t("alreadyExists", { value }) : failure);
      // A value renamed or deleted elsewhere: show the list as it is now.
      void queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all }, { throwOnError: false });
    } finally {
      commandInFlight.current = false;
      setSavingValue(null);
    }
  }

  const addValue = () => {
    const value = newValue.trim();
    if (!value || !attributeId) return;
    void run(
      "new",
      () => apiData(postApiV1AdminAttributesByIdValues({ path: { id: attributeId }, body: { value } })),
      t("added"),
      t("addFailed"),
      () => {
        setNewValue("");
        setIsAddingNew(false);
      },
      value,
    );
  };

  const saveRename = () => {
    const next = editedValue.trim();
    if (!editingValue || !next || !attributeId) return;
    void run(
      editingValue,
      () =>
        apiData(
          putApiV1AdminAttributesByIdValues({ path: { id: attributeId }, body: { oldValue: editingValue, newValue: next } }),
        ),
      t("renamed"),
      t("renameFailed"),
      () => {
        setEditingValue(null);
        setEditedValue("");
      },
      next,
    );
  };

  const deleteValue = (value: string) => {
    if (!attributeId) return;
    void run(
      value,
      () => apiData(deleteApiV1AdminAttributesByIdValues({ path: { id: attributeId }, body: { value } })),
      t("deleted"),
      t("deleteFailed"),
      () => setDeleteConfirm(null),
    );
  };

  const close = () => {
    if (!commandInFlight.current) onClose();
  };
  const cancelAdd = () => {
    if (commandInFlight.current) return;
    setIsAddingNew(false);
    setNewValue("");
  };
  const cancelRename = () => {
    if (commandInFlight.current) return;
    setEditingValue(null);
    setEditedValue("");
  };

  const loaded = !isLoading && !valuesQuery.isError;
  const stat = (count: number | undefined) => (loaded ? formatNumber(count ?? 0) : "–");

  return (
    <>
      <Dialog open={Boolean(attributeId)} onOpenChange={close}>
        <DialogContent
          className="sm:max-w-2xl"
          showCloseButton={!pending}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const row = Array.from(document.querySelectorAll<HTMLElement>("[data-attribute-values-opener]"))
              .find((node) => node.dataset.attributeValuesOpener === openerAttributeId.current)
              ?.closest("tr");
            const replacement = row?.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
            (openerRef.current?.isConnected ? openerRef.current : replacement)?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="break-words">{t("title", { name: attributeName ?? "" })}</DialogTitle>
            <DialogDescription>{t(readOnly ? "viewDescription" : "editDescription")}</DialogDescription>
          </DialogHeader>

          <fieldset disabled={pending} className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 flex-1">
                <Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  aria-label={t("searchValues")}
                  placeholder={t("searchValues")}
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  // eslint-disable-next-line shadcn/no-restyle -- room for the search icon inside the field
                  className="pl-9"
                />
              </div>
              {readOnly ? null : isAddingNew ? (
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    aria-label={t("newValue")}
                    placeholder={t("newValue")}
                    value={newValue}
                    autoFocus
                    onChange={(event) => setNewValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addValue();
                      }
                      if (event.key === "Escape") cancelAdd();
                    }}
                  />
                  <Button
                    size="icon"
                    className="shrink-0"
                    aria-label={t("saveNewValue")}
                    disabled={!newValue.trim() || valuesQuery.isError}
                    loading={savingValue === "new"}
                    onClick={addValue}
                  >
                    <Check />
                  </Button>
                  <Button size="icon" variant="ghost" className="shrink-0" aria-label={t("cancelNewValue")} onClick={cancelAdd}>
                    <X />
                  </Button>
                </div>
              ) : (
                <Button variant="outline" disabled={valuesQuery.isError} onClick={() => setIsAddingNew(true)}>
                  <Plus aria-hidden="true" />
                  {t("addValue")}
                </Button>
              )}
            </div>

            <p className="text-body text-muted-foreground tabular-nums">
              {t("summary", { values: stat(valuesQuery.data?.totalValues), products: stat(valuesQuery.data?.totalProducts) })}
            </p>

            <div className="overflow-clip rounded-lg border">
              {isLoading ? (
                <div role="status" aria-label={t("loading")} className="flex min-h-64 items-center justify-center">
                  <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : valuesQuery.isError ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-4 text-center">
                  <p className="text-body">{t("loadFailed")}</p>
                  <Button variant="outline" size="sm" onClick={() => void valuesQuery.refetch()}>
                    {t("retry")}
                  </Button>
                </div>
              ) : values.length === 0 ? (
                <p className="flex min-h-64 items-center justify-center p-4 text-center text-body text-muted-foreground">
                  {t(searchQuery ? "noMatches" : "noValues")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("value")}</TableHead>
                      <TableHead className="w-24 text-right">{t("products")}</TableHead>
                      {readOnly ? null : <TableHead className="w-24" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {values.map((item) => (
                      <TableRow key={item.value}>
                        <TableCell>
                          {editingValue === item.value ? (
                            <div className="flex items-center gap-2">
                              <Input
                                aria-label={t("renameField", { value: item.value })}
                                value={editedValue}
                                autoFocus
                                onChange={(event) => setEditedValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    saveRename();
                                  }
                                  if (event.key === "Escape") cancelRename();
                                }}
                              />
                              <Button
                                size="icon-sm"
                                className="shrink-0"
                                aria-label={t("saveRename", { value: item.value })}
                                disabled={!editedValue.trim()}
                                loading={savingValue === item.value}
                                onClick={saveRename}
                              >
                                <Check />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                className="shrink-0"
                                aria-label={t("cancelRename", { value: item.value })}
                                onClick={cancelRename}
                              >
                                <X />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium break-words">{item.value}</span>
                                {item.isPreset ? <Badge variant="secondary">{t("preset")}</Badge> : null}
                              </span>
                              {item.sampleProducts?.length ? (
                                <span className="truncate text-muted-foreground">
                                  {item.sampleProducts.slice(0, 3).join(", ")}
                                  {item.sampleProducts.length > 3 ? ` ${t("moreProducts", { count: item.sampleProducts.length - 3 })}` : ""}
                                </span>
                              ) : null}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{formatNumber(item.productCount)}</TableCell>
                        {readOnly ? null : (
                          <TableCell>
                            {editingValue === item.value ? null : (
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("rename", { value: item.value })}
                                  onClick={() => {
                                    if (commandInFlight.current) return;
                                    setEditingValue(item.value);
                                    setEditedValue(item.value);
                                  }}
                                >
                                  <Pencil />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={t("delete", { value: item.value })}
                                  onClick={() => setDeleteConfirm(item.value)}
                                >
                                  <Trash2 />
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {loaded && valuesQuery.data && valuesQuery.data.totalValues > 0 ? (
                <AdminListPagination
                  pagination={{
                    total: valuesQuery.data.totalValues,
                    page: valuesQuery.data.page,
                    limit: valuesQuery.data.limit,
                    totalPages: valuesQuery.data.totalPages,
                  }}
                  onPageChange={setPage}
                />
              ) : null}
            </div>
          </fieldset>

          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={close}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteConfirm)}
        onOpenChange={() => {
          if (!commandInFlight.current) setDeleteConfirm(null);
        }}
        title={t("deleteTitle", { value: deleteConfirm ?? "" })}
        description={t("deleteBody")}
        confirmLabel={t("deleteConfirm")}
        cancelLabel={t("cancel")}
        loadingLabel={t("deleting")}
        isLoading={pending}
        variant="destructive"
        onConfirm={() => deleteConfirm && deleteValue(deleteConfirm)}
      />
    </>
  );
}
