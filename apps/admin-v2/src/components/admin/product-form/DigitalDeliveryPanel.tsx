import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, MoreHorizontal } from "lucide-react";
import {
  deleteApiV1AdminDigitalAssetsById,
  getApiV1AdminProductsByIdDigitalAssets,
  patchApiV1AdminDigitalAssetsById,
  postApiV1AdminProductsByIdDigitalAssets,
} from "@scalius/api-client/sdk";
import { DIGITAL_DOWNLOAD_LIMIT_DEFAULT, DIGITAL_MAX_FILE_BYTES } from "@scalius/shared/digital";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { NumberInput } from "@/components/ui/number-input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import { AdminApiResponseError } from "@/lib/admin-api-error";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { productQueryOptions, type ProductVariant } from "@/lib/api-query-options/products";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { digitalMessages, type DigitalMessageKey } from "~/i18n/digital";
import { resourceMessages } from "~/i18n/resource";
import {
  fileInput,
  formatBytes,
  resumeOrRestart,
  sendDigitalFile,
  startDigitalUpload,
  type DigitalAssetDto,
  type DigitalUploadSessionDto,
} from "./digital-upload";
import { KeyImportDialog, KeyRevokeDialog } from "./DigitalKeyDialogs";

type T = (key: DigitalMessageKey, vars?: Record<string, string | number>) => string;

export const digitalAssetsKey = (productId: string) => [...queryKeys.products.detail(productId), "digital-assets"] as const;

/** A known refusal in words; anything else as the server said it. */
export function digitalErrorText(error: unknown, t: T): string {
  if (error instanceof AdminApiResponseError) {
    if (error.code === "DIGITAL_ASSET_CHANGED") return t("changed");
    if (error.code === "DIGITAL_ASSET_IN_USE") return t("inUse");
  }
  return getServerFnError(error);
}

/** "Blue / Large", or null for a product without options. */
export function variantLabel(variant: Pick<ProductVariant, "selectedOptions">): string | null {
  return variant.selectedOptions.map((option) => option.value).join(" / ") || null;
}

const STATUS: Record<DigitalAssetDto["status"], { key: DigitalMessageKey; variant: BadgeVariant }> = {
  draft: { key: "statusDraft", variant: "attention" },
  ready: { key: "statusReady", variant: "success" },
  archived: { key: "statusArchived", variant: "secondary" },
};

interface Upload {
  assetId: string;
  file: File;
  uploadId: string | null;
  sent: number;
  failed: string | null;
  controller: AbortController;
}

export function DigitalDeliveryPanel({ productId, readOnly }: { productId: string | undefined; readOnly: boolean }) {
  const t = useMessages(digitalMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {productId ? (
          <DigitalItems productId={productId} readOnly={readOnly} />
        ) : (
          <p className="text-body text-muted-foreground">{t("saveFirst")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DigitalItems({ productId, readOnly }: { productId: string; readOnly: boolean }) {
  const t = useMessages(digitalMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const key = digitalAssetsKey(productId);
  const assetsQuery = useQuery({
    queryKey: key,
    queryFn: async () => (await apiData(getApiV1AdminProductsByIdDigitalAssets({ path: { id: productId } }))).assets,
  });
  // The editor already holds the saved product; its variants say which SKUs are digital.
  const productQuery = useQuery({ ...productQueryOptions(productId), staleTime: Number.POSITIVE_INFINITY });
  const digitalVariants = (productQuery.data?.variants ?? [])
    .filter((variant) => !variant.deletedAt && variant.fulfillmentKind === "digital");
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const putAsset = (asset: DigitalAssetDto) => queryClient.setQueryData<DigitalAssetDto[]>(key, (current = []) =>
    current.some((item) => item.id === asset.id) ? current.map((item) => (item.id === asset.id ? asset : item)) : [...current, asset]);

  const [target, setTarget] = React.useState("");
  const [upload, setUpload] = React.useState<Upload | null>(null);
  const uploadRef = React.useRef<Upload | null>(null);
  uploadRef.current = upload;
  React.useEffect(() => () => uploadRef.current?.controller.abort(), []);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const replaceFor = React.useRef<string | null>(null);
  const [editing, setEditing] = React.useState<DigitalAssetDto | null>(null);
  const [deleting, setDeleting] = React.useState<DigitalAssetDto | null>(null);
  const [importFor, setImportFor] = React.useState<{ variant: ProductVariant; pool: DigitalAssetDto | null } | null>(null);
  const [revokeFor, setRevokeFor] = React.useState<DigitalAssetDto | null>(null);

  /** Sends the file's parts (resuming a failed upload), then marks the item ready. */
  const send = async (assetId: string, file: File, session: DigitalUploadSessionDto | null, uploadId: string | null = null) => {
    const controller = new AbortController();
    setUpload({ assetId, file, uploadId: session?.id ?? uploadId, sent: 0, failed: null, controller });
    let current = session;
    try {
      current ??= await resumeOrRestart(assetId, uploadId, file);
      const started = current;
      setUpload((value) => (value?.controller === controller ? { ...value, uploadId: started.id } : value));
      const asset = await sendDigitalFile({
        assetId,
        session: current,
        file,
        signal: controller.signal,
        onProgress: (sent) => setUpload((value) => (value?.controller === controller ? { ...value, sent } : value)),
      });
      putAsset(asset);
      setUpload(null);
      toast.success(t("fileUploaded"));
    } catch (error) {
      if (controller.signal.aborted) {
        setUpload((value) => (value?.controller === controller ? null : value));
      } else {
        setUpload((value) => (value?.controller === controller ? { ...value, failed: getServerFnError(error) } : value));
      }
    } finally {
      void refresh();
    }
  };

  const onFileChosen = async (file: File) => {
    if (file.size > DIGITAL_MAX_FILE_BYTES) {
      toast.error(t("tooBig"));
      return;
    }
    const assetId = replaceFor.current;
    try {
      if (assetId) {
        await send(assetId, file, await startDigitalUpload(assetId, file));
        return;
      }
      const created = await apiData(postApiV1AdminProductsByIdDigitalAssets({
        path: { id: productId },
        body: { kind: "file", variantId: target || null, ...fileInput(file) },
      }));
      putAsset(created.asset);
      await send(created.asset.id, file, created.upload);
    } catch (error) {
      toast.error(digitalErrorText(error, t));
    }
  };

  const pickFile = (assetId: string | null) => {
    replaceFor.current = assetId;
    fileRef.current?.click();
  };

  const setStatus = useMutation({
    mutationFn: ({ asset, status }: { asset: DigitalAssetDto; status: "ready" | "archived" }) =>
      apiData(patchApiV1AdminDigitalAssetsById({ path: { id: asset.id }, body: { version: asset.version, status } })),
    onSuccess: ({ asset }) => {
      putAsset(asset);
      toast.success(t(asset.status === "archived" ? "fileArchived" : "fileRestored"));
    },
    onError: (error) => toast.error(digitalErrorText(error, t)),
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (asset: DigitalAssetDto) => apiData(deleteApiV1AdminDigitalAssetsById({ path: { id: asset.id } })),
    onSuccess: () => toast.success(t("fileDeleted")),
    onError: (error) => toast.error(digitalErrorText(error, t)),
    onSettled: () => void refresh(),
  });

  if (assetsQuery.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (assetsQuery.isError) {
    return (
      <p role="alert" className="text-body text-destructive">
        {t("loadFailed")}{" "}
        <Button type="button" variant="link" onClick={() => void assetsQuery.refetch()}>{r("retry")}</Button>
      </p>
    );
  }

  const assets = assetsQuery.data;
  const files = assets.filter((asset) => asset.kind === "file");
  const labelOf = (variantId: string | null) => {
    const variant = variantId ? digitalVariants.find((item) => item.id === variantId) : null;
    return variant ? variantLabel(variant) : null;
  };
  const busy = upload !== null && upload.failed === null;

  return (
    <>
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-body font-medium">{t("files")}</h3>
          {readOnly ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {digitalVariants.length > 1 ? (
                <SearchableSelect
                  ariaLabel={t("deliverTo")}
                  value={target}
                  onValueChange={setTarget}
                  triggerClassName="w-full"
                  options={[{ value: "", label: t("everyDigitalVariant") }, ...digitalVariants.map((variant) => ({ value: variant.id, label: variantLabel(variant) ?? variant.sku }))]}
                />
              ) : null}
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => pickFile(null)}>{t("addFile")}</Button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onFileChosen(file);
            }}
          />
        </div>
        {files.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("filesEmpty")}</p>
        ) : (
          <ul className="divide-y">
            {files.map((asset) => {
              const mine = upload?.assetId === asset.id ? upload : null;
              const scope = labelOf(asset.variantId);
              const status = mine && !mine.failed ? { key: "statusUploading" as const, variant: "info" as const } : STATUS[asset.status];
              const facts = [
                asset.filename,
                asset.sizeBytes ? formatBytes(asset.sizeBytes) : null,
                scope ? t("onlyVariant", { variant: scope }) : null,
              ].filter(Boolean).join(" · ");
              const terms = [
                asset.downloadLimit === null ? t("unlimitedDownloads") : t("downloadLimit", { count: asset.downloadLimit }),
                asset.accessDays === null ? t("accessForever") : t("accessDays", { count: asset.accessDays }),
                asset.deliveredCount > 0 ? t("delivered", { count: asset.deliveredCount }) : null,
              ].filter(Boolean).join(" · ");
              return (
                <li key={asset.id} className="flex items-start gap-3 py-3 text-body first:pt-0 last:pb-0">
                  <span className="flex h-lh items-center"><FileText className="size-5 text-muted-foreground" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1 break-words">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{asset.displayName}</span>
                      <Badge variant={status.variant}>{t(status.key)}</Badge>
                    </p>
                    {facts ? <p className="text-muted-foreground">{facts}</p> : null}
                    <p className="text-muted-foreground">{terms}</p>
                    {mine ? (
                      <div className="mt-2 space-y-1">
                        <Progress value={Math.round((mine.sent / Math.max(mine.file.size, 1)) * 100)} aria-label={t("statusUploading")} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-muted-foreground tabular-nums">
                            {t("uploadProgress", { sent: formatBytes(mine.sent), total: formatBytes(mine.file.size) })}
                          </span>
                          {mine.failed ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span role="alert" className="text-destructive">{t("uploadFailed", { reason: mine.failed })}</span>
                              <Button type="button" size="sm" variant="outline" onClick={() => void send(asset.id, mine.file, null, mine.uploadId)}>{r("retry")}</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => setUpload(null)}>{r("cancel")}</Button>
                            </span>
                          ) : (
                            <Button type="button" size="sm" variant="ghost" onClick={() => mine.controller.abort()}>{t("cancelUpload")}</Button>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {readOnly ? null : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: asset.displayName })}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(asset)}>{t("edit")}</DropdownMenuItem>
                        {asset.status !== "archived" ? (
                          <DropdownMenuItem disabled={busy} onSelect={() => pickFile(asset.id)}>
                            {t(asset.hasFile ? "replaceFile" : "uploadFile")}
                          </DropdownMenuItem>
                        ) : null}
                        {asset.status === "ready" ? (
                          <DropdownMenuItem onSelect={() => setStatus.mutate({ asset, status: "archived" })}>{t("archive")}</DropdownMenuItem>
                        ) : null}
                        {asset.status === "archived" && asset.hasFile ? (
                          <DropdownMenuItem onSelect={() => setStatus.mutate({ asset, status: "ready" })}>{t("restore")}</DropdownMenuItem>
                        ) : null}
                        {asset.deliveredCount === 0 && !mine ? (
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(asset)}>{t("delete")}</DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2 border-t pt-4">
        <div className="space-y-1">
          <h3 className="text-body font-medium">{t("keys")}</h3>
          <p className="text-body text-muted-foreground">{t("keysHelp")}</p>
        </div>
        {digitalVariants.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("keysNoVariant")}</p>
        ) : (
          <ul className="divide-y">
            {digitalVariants.map((variant) => {
              const pool = assets.find((asset) => asset.kind === "licence_keys" && asset.variantId === variant.id) ?? null;
              const tracked = variant.trackInventory !== false;
              const label = variantLabel(variant);
              return (
                <li key={variant.id} className="flex flex-wrap items-start justify-between gap-2 py-3 text-body first:pt-0 last:pb-0">
                  <div className="min-w-0 break-words">
                    {label ? <p className="font-medium">{label}</p> : null}
                    <p className="text-muted-foreground tabular-nums">
                      {pool ? t("keysCounts", { available: pool.keys.available, assigned: pool.keys.assigned }) : t("keysNone")}
                    </p>
                    {tracked ? null : <p className="text-warning">{t("keysNotTracked")}</p>}
                    {tracked && pool && pool.status !== "archived" && pool.keys.available === 0 ? (
                      <p className="text-warning">{t("outOfKeys")}</p>
                    ) : null}
                  </div>
                  {readOnly || !tracked ? null : (
                    <div className="flex flex-wrap gap-2">
                      {pool && pool.keys.available > 0 ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setRevokeFor(pool)}>{t("revokeUnused")}</Button>
                      ) : null}
                      <Button type="button" variant="outline" size="sm" onClick={() => setImportFor({ variant, pool })}>{t("importKeys")}</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <FileSettingsDialog asset={editing} onOpenChange={(open) => { if (!open) setEditing(null); }} onSaved={putAsset} onChanged={refresh} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t("deleteTitle", { name: deleting?.displayName ?? "" })}
        description={t("deleteBody")}
        confirmLabel={t("delete")}
        cancelLabel={r("cancel")}
        isLoading={remove.isPending}
        onConfirm={() => { if (deleting) remove.mutate(deleting); }}
      />
      <KeyImportDialog
        productId={productId}
        target={importFor ? { variantId: importFor.variant.id, label: variantLabel(importFor.variant), poolId: importFor.pool?.id ?? null } : null}
        onOpenChange={(open) => { if (!open) setImportFor(null); }}
        onChanged={refresh}
      />
      <KeyRevokeDialog
        productId={productId}
        poolId={revokeFor?.id ?? null}
        onOpenChange={(open) => { if (!open) setRevokeFor(null); }}
        onChanged={refresh}
      />
    </>
  );
}

/** Name, downloads per purchase (Unlimited or 1–100) and access (Forever or 1–3650 days) of one file. */
function FileSettingsDialog({ asset, onOpenChange, onSaved, onChanged }: {
  asset: DigitalAssetDto | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (asset: DigitalAssetDto) => void;
  onChanged: () => void;
}) {
  const t = useMessages(digitalMessages);
  const r = useMessages(resourceMessages);
  const [name, setName] = React.useState("");
  const [limit, setLimit] = React.useState<number | null>(DIGITAL_DOWNLOAD_LIMIT_DEFAULT);
  const [limited, setLimited] = React.useState(true);
  const [days, setDays] = React.useState<number | null>(null);
  const [expires, setExpires] = React.useState(false);
  const [checked, setChecked] = React.useState(false);
  const open = asset !== null;
  const save = useMutation({
    mutationFn: (body: { displayName: string; downloadLimit: number | null; accessDays: number | null }) =>
      apiData(patchApiV1AdminDigitalAssetsById({ path: { id: asset!.id }, body: { version: asset!.version, ...body } })),
    onSuccess: ({ asset: saved }) => {
      onSaved(saved);
      toast.success(t("fileSaved"));
      onOpenChange(false);
    },
    onSettled: onChanged,
  });
  React.useEffect(() => {
    if (!asset) return;
    setName(asset.displayName);
    setLimited(asset.downloadLimit !== null);
    setLimit(asset.downloadLimit ?? DIGITAL_DOWNLOAD_LIMIT_DEFAULT);
    setExpires(asset.accessDays !== null);
    setDays(asset.accessDays);
    setChecked(false);
    save.reset();
    // Every opening starts from the file as saved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id, open]);
  const whole = (value: number | null, max: number) => value !== null && Number.isInteger(value) && value >= 1 && value <= max;
  const nameIssue = name.trim() ? null : t("nameRequired");
  const limitIssue = limited && !whole(limit, 100) ? t("limitRange") : null;
  const daysIssue = expires && !whole(days, 3650) ? t("daysRange") : null;
  const submit = () => {
    setChecked(true);
    if (nameIssue || limitIssue || daysIssue) return;
    save.mutate({ displayName: name.trim(), downloadLimit: limited ? limit : null, accessDays: expires ? days : null });
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !save.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle", { name: asset?.displayName ?? "" })}</DialogTitle>
          <DialogDescription>{t("appliesToNew")}</DialogDescription>
        </DialogHeader>
        <form method="post"
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="digital-file-name">{t("nameLabel")}</Label>
            <Input id="digital-file-name" value={name} maxLength={200} aria-invalid={checked && nameIssue ? true : undefined} onChange={(event) => setName(event.target.value)} />
            {checked && nameIssue ? <p className="text-body text-destructive">{nameIssue}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="digital-file-limit">{t("downloadsLabel")}</Label>
              <SearchableSelect
                id="digital-file-limit"
                value={limited ? "limited" : "unlimited"}
                onValueChange={(value) => setLimited(value === "limited")}
                triggerClassName="w-full"
                options={[{ value: "limited", label: t("limited") }, { value: "unlimited", label: t("unlimited") }]}
              />
              {limited ? (
                <>
                  <NumberInput integer aria-label={t("downloadCountLabel")} value={limit} aria-invalid={checked && limitIssue ? true : undefined} onValueChange={setLimit} />
                  {checked && limitIssue ? <p className="text-body text-destructive">{limitIssue}</p> : null}
                </>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="digital-file-access">{t("accessLabel")}</Label>
              <SearchableSelect
                id="digital-file-access"
                value={expires ? "days" : "forever"}
                onValueChange={(value) => setExpires(value === "days")}
                triggerClassName="w-full"
                options={[{ value: "forever", label: t("forever") }, { value: "days", label: t("limitedTime") }]}
              />
              {expires ? (
                <>
                  <NumberInput integer aria-label={t("daysLabel")} placeholder={t("daysLabel")} value={days} aria-invalid={checked && daysIssue ? true : undefined} onValueChange={setDays} />
                  {checked && daysIssue ? <p className="text-body text-destructive">{daysIssue}</p> : null}
                </>
              ) : null}
            </div>
          </div>
          {save.isError ? <p role="alert" className="text-body text-destructive">{digitalErrorText(save.error, t)}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
            <Button type="submit" loading={save.isPending}>{r("save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
