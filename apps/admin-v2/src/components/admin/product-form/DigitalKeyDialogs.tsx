import React from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getApiV1AdminDigitalAssetsByIdLicenceKeys,
  postApiV1AdminDigitalAssetsByIdLicenceKeys,
  postApiV1AdminDigitalAssetsByIdLicenceKeysRevoke,
  postApiV1AdminProductsByIdDigitalAssets,
} from "@scalius/api-client/sdk";
import {
  maskLicenceKey,
  normalizeLicenceKeyImport,
  type LicenceKeyRejectReason,
} from "@scalius/shared/digital";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { queryKeys } from "@/lib/query-keys";
import { useMessages } from "~/i18n";
import { digitalMessages } from "~/i18n/digital";
import { resourceMessages } from "~/i18n/resource";

const REJECT_TEXT: Record<LicenceKeyRejectReason, "rejectTooLong" | "rejectInvalid" | "rejectDuplicate"> = {
  too_long: "rejectTooLong",
  invalid_characters: "rejectInvalid",
  duplicate: "rejectDuplicate",
};
/** Skipped lines listed before "and N more". */
const SHOWN_REJECTS = 10;
/** Keys one revoke request takes (the API's bound-parameter chunk). */
export const REVOKE_BATCH = 90;

/**
 * Import keys into a variant's pool (made on the first import): paste or a
 * CSV/TXT file, checked here first (≤ 500 keys, no repeats). The keys never
 * outlive the dialog: the text is cleared when it closes.
 */
export function KeyImportDialog({ productId, target, onOpenChange, onChanged }: {
  productId: string;
  /** The variant whose stock the keys become; null while closed. */
  target: { variantId: string; label: string | null; poolId: string | null } | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const t = useMessages(digitalMessages);
  const r = useMessages(resourceMessages);
  const open = target !== null;
  const [text, setText] = React.useState("");
  const parsed = React.useMemo(() => normalizeLicenceKeyImport(text), [text]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  // One key per content: repeating the same import replays it, never doubles the stock.
  const requestKey = React.useRef("");
  const changeText = (value: string) => {
    requestKey.current = crypto.randomUUID();
    setText(value);
  };
  const createdPool = React.useRef<string | null>(null);
  // Not a useMutation: its cache would keep the keys (the variables) after the dialog closes.
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (!target || pending) return;
    setPending(true);
    setError(null);
    try {
      let poolId = target.poolId ?? createdPool.current;
      if (!poolId) {
        const { asset } = await apiData(postApiV1AdminProductsByIdDigitalAssets({
          path: { id: productId },
          body: { kind: "licence_keys", variantId: target.variantId },
        }));
        poolId = createdPool.current = asset.id;
      }
      const result = await apiData(postApiV1AdminDigitalAssetsByIdLicenceKeys({ path: { id: poolId }, body: { requestKey: requestKey.current, keys: parsed.keys } }));
      toast.success(t("keysImported", { count: result.imported }), {
        description: result.alreadyInPool > 0 ? t("alreadyInPool", { count: result.alreadyInPool }) : undefined,
      });
      onOpenChange(false);
    } catch (failure) {
      setError(getServerFnError(failure));
    } finally {
      setPending(false);
      onChanged();
    }
  };
  React.useEffect(() => {
    if (open) return;
    setText("");
    setError(null);
    createdPool.current = null;
  }, [open]);

  const blocked = parsed.keys.length === 0 || parsed.exceedsLimit;
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{target?.label ? t("importTitleFor", { variant: target.label }) : t("importTitle")}</DialogTitle>
          <DialogDescription>{t("importHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="licence-keys-text">{t("keysField")}</Label>
            <Textarea
              id="licence-keys-text"
              rows={8}
              value={text}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="licence-keys-summary"
              onChange={(event) => changeText(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id="licence-keys-summary" className="text-body text-muted-foreground tabular-nums">
              {t("willImport", { count: parsed.keys.length })}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>{t("chooseFile")}</Button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void file.text().then(changeText);
              }}
            />
          </div>
          {parsed.exceedsLimit ? (
            <p role="alert" className="text-body text-destructive">{t("tooMany")}</p>
          ) : null}
          {parsed.rejects.length > 0 ? (
            <div className="space-y-1 text-body">
              <p className="font-medium">{t("skippedLines")}</p>
              <ul className="text-muted-foreground">
                {parsed.rejects.slice(0, SHOWN_REJECTS).map((reject) => (
                  <li key={reject.line}>{t(REJECT_TEXT[reject.reason], { line: reject.line })}</li>
                ))}
                {parsed.rejects.length > SHOWN_REJECTS ? (
                  <li>{t("andMore", { count: parsed.rejects.length - SHOWN_REJECTS })}</li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{r("cancel")}</Button>
          <Button type="button" loading={pending} disabled={blocked} onClick={() => void submit()}>{t("importSubmit")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Revoke unused": pick unused keys (shown by their last 4) and take them out of stock. */
export function KeyRevokeDialog({ productId, poolId, onOpenChange, onChanged }: {
  productId: string;
  /** The pool; null while closed. */
  poolId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const t = useMessages(digitalMessages);
  const r = useMessages(resourceMessages);
  const open = poolId !== null;
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const keys = useInfiniteQuery({
    queryKey: [...queryKeys.products.detail(productId), "licence-keys", poolId],
    queryFn: ({ pageParam }) => apiData(getApiV1AdminDigitalAssetsByIdLicenceKeys({
      path: { id: poolId! },
      query: { status: "available", cursor: pageParam, limit: 100 },
    })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open,
    staleTime: 0,
  });
  const items = keys.data?.pages.flatMap((page) => page.items) ?? [];
  // One key per selection: repeating the same revoke replays it.
  const requestKey = React.useRef("");
  const choose = (next: ReadonlySet<string>) => {
    requestKey.current = crypto.randomUUID();
    setSelected(next);
  };
  const run = useMutation({
    mutationFn: (keyIds: string[]) => apiData(postApiV1AdminDigitalAssetsByIdLicenceKeysRevoke({
      path: { id: poolId! },
      body: { requestKey: requestKey.current, keyIds },
    })),
    onSuccess: (result) => {
      toast.success(t("keysRevoked", { count: result.revoked }));
      onOpenChange(false);
    },
    onSettled: () => {
      onChanged();
      void keys.refetch();
    },
  });
  React.useEffect(() => {
    if (open) return;
    setSelected(new Set());
    run.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on && next.size < REVOKE_BATCH) next.add(id);
    else next.delete(id);
    choose(next);
  };
  const firstCount = Math.min(items.length, REVOKE_BATCH);
  return (
    <AlertDialog open={open} onOpenChange={(next) => !run.isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("revokeTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("revokeHelp")}</AlertDialogDescription>
        </AlertDialogHeader>
        {keys.isPending ? (
          <p className="text-body text-muted-foreground">{r("loading")}</p>
        ) : keys.isError ? (
          <p role="alert" className="text-body text-destructive">{getServerFnError(keys.error)}</p>
        ) : items.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("noUnused")}</p>
        ) : (
          <div className="space-y-2">
            <Button type="button" variant="link" onClick={() => choose(new Set(items.slice(0, REVOKE_BATCH).map((item) => item.id)))}>
              {t("selectFirst", { count: firstCount })}
            </Button>
            <ul className="max-h-72 overflow-y-auto">
              {items.map((item) => {
                const masked = maskLicenceKey(item.last4);
                return (
                  <li key={item.id}>
                    <label className="flex items-center gap-2 py-1 text-body">
                      <Checkbox
                        checked={selected.has(item.id)}
                        disabled={!selected.has(item.id) && selected.size >= REVOKE_BATCH}
                        aria-label={t("selectKey", { key: masked })}
                        onCheckedChange={(checked) => toggle(item.id, checked === true)}
                      />
                      <code>{masked}</code>
                    </label>
                  </li>
                );
              })}
            </ul>
            {keys.hasNextPage ? (
              <Button type="button" variant="outline" size="sm" loading={keys.isFetchingNextPage} onClick={() => void keys.fetchNextPage()}>
                {t("showMore")}
              </Button>
            ) : null}
          </div>
        )}
        {run.isError ? <p role="alert" className="text-body text-destructive">{getServerFnError(run.error)}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>{r("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={selected.size === 0 || run.isPending}
            onClick={(event) => {
              event.preventDefault();
              run.mutate([...selected]);
            }}
          >
            {t("revokeSubmit", { count: selected.size })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
