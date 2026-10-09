// Create a price list: its name, type, market and (for a segment list) its
// customer segment. It starts as a draft; the dialog leads to its page, where
// the merchant adds prices and makes it active.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PRICE_LIST_NAME_MAX_LENGTH } from "@scalius/shared/market-pricing";
import { toast } from "~/lib/toast";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { useSubmitOnce } from "~/components/admin/shared/use-submit-once";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { priceListMessages, type PriceListMessageKey } from "~/i18n/price-lists";
import { getServerFnError } from "~/lib/api-helpers";
import { priceListChoicesQueryOptions, useCreatePriceList } from "~/lib/api-query-options/price-lists";
import { KIND_HELP, KIND_LABEL, PRICE_LIST_KINDS, type PriceListKind } from "./price-list-form";
import { Field } from "~/components/ui/field";

type Problems = Partial<Record<"name" | "market" | "segment", PriceListMessageKey>>;

export function CreatePriceListDialog({ open, onOpenChange, marketId: fixedMarket }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened from a market's page: that market is chosen. */
  marketId?: string;
}) {
  const t = useMessages(priceListMessages);
  const navigate = useNavigate();
  const choices = useQuery({ ...priceListChoicesQueryOptions(), enabled: open });
  const [name, setName] = useState("");
  const [chosenKind, setKind] = useState<PriceListKind>("market");
  const [marketId, setMarketId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const create = useCreatePriceList();
  const submitOnce = useSubmitOnce();
  const reset = create.reset;

  useEffect(() => {
    if (!open) return;
    setName("");
    setKind("market");
    setMarketId(fixedMarket ?? "");
    setSegmentId("");
    setProblems({});
    reset();
  }, [open, reset, fixedMarket]);

  // Market and sale lists price a market other than the primary one (it sells at the product prices),
  // so a store with one market can only make a customer segment list.
  const needsMarket = choices.data !== undefined && !choices.data.markets.some((market) => !market.isBackup);
  const kind: PriceListKind = needsMarket ? "segment" : chosenKind;
  const markets = (choices.data?.markets ?? []).filter((market) => kind === "segment" || !market.isBackup);
  // With one market there is nothing to choose: its list prices it.
  const chosenMarket = markets.some((market) => market.id === marketId) ? marketId : needsMarket ? markets[0]?.id ?? "" : "";
  const segments = choices.data?.segments ?? [];
  const dirty = name.trim() !== "" || segmentId !== "" || (marketId !== "" && marketId !== fixedMarket);
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: create.isPending, onClose: () => onOpenChange(false) });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: Problems = {};
    if (!name.trim()) found.name = "nameRequired";
    if (!chosenMarket) found.market = "marketRequired";
    if (kind === "segment" && !segmentId) found.segment = "segmentRequired";
    setProblems(found);
    const first = found.name ? "price-list-create-name" : found.market ? "price-list-create-market" : found.segment ? "price-list-create-segment" : null;
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    // One request at a time: a double click must not add the list twice.
    submitOnce(async () => {
      const list = await create.mutateAsync({
        name: name.trim(),
        kind,
        marketId: chosenMarket,
        segmentId: kind === "segment" ? segmentId : null,
        status: "draft",
      });
      toast.success(t("created"));
      onOpenChange(false);
      await navigate({ to: "/admin/price-lists/$priceListId", params: { priceListId: list.id } });
    });
  };

  const serverError = create.error ? getServerFnError(create.error, t("createFailed")) : null;
  const note = (field: keyof Problems, help?: string) =>
    problems[field] ? (
      <p id={`price-list-create-${field}-note`} className="text-body text-destructive">{t(problems[field]!)}</p>
    ) : help ? (
      <p id={`price-list-create-${field}-note`} className="text-body text-muted-foreground">{help}</p>
    ) : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createBody")}</DialogDescription>
          </DialogHeader>
          {choices.isError ? (
            <Alert variant="destructive"><AlertDescription>{t("loadFailed")}</AlertDescription></Alert>
          ) : !choices.data ? (
            <div className="space-y-3">
              {[0, 1, 2].map((index) => <Skeleton key={index} className="h-10 w-full" />)}
            </div>
          ) : (
            <form id="price-list-create-form" method="post" noValidate className="space-y-4" onSubmit={submit}>
              {serverError ? <Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert> : null}
              <Field id="price-list-create-name" label={t("name")}>
                <Input
                  id="price-list-create-name"
                  value={name}
                  maxLength={PRICE_LIST_NAME_MAX_LENGTH}
                  autoComplete="off"
                  aria-invalid={problems.name ? true : undefined}
                  aria-describedby="price-list-create-name-note"
                  onChange={(event) => {
                    setName(event.target.value);
                    if (problems.name) setProblems((current) => ({ ...current, name: undefined }));
                  }}
                />
                {note("name", t("nameHelp"))}
              </Field>
              <fieldset className="space-y-1">
                <legend className="mb-1 text-body font-medium">{t("type")}</legend>
                <RadioGroup value={kind} onValueChange={(value) => setKind(value as PriceListKind)}>
                  {PRICE_LIST_KINDS.map((option) => (
                    <label key={option} className="flex min-h-11 items-start gap-2 py-1 text-body">
                      <span className="flex h-lh items-center"><RadioGroupItem value={option} disabled={needsMarket && option !== "segment"} /></span>
                      <span>
                        <span className="block font-medium">{t(KIND_LABEL[option])}</span>
                        <span className="block text-muted-foreground">{needsMarket && option !== "segment" ? t("kindNeedsMarket") : t(KIND_HELP[option])}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
              {needsMarket ? null : (
              <Field id="price-list-create-market" label={t("market")}>
                <SearchableSelect
                  id="price-list-create-market"
                  value={chosenMarket}
                  aria-invalid={problems.market ? true : undefined}
                  aria-describedby="price-list-create-market-note"
                  triggerClassName="block w-full"
                  options={markets.map((market) => ({ value: market.id, label: market.name }))}
                  emptyMessage={t("noOtherMarkets")}
                  onValueChange={(value) => {
                    setMarketId(value);
                    if (problems.market) setProblems((current) => ({ ...current, market: undefined }));
                  }}
                />
                {note("market", kind === "segment" ? undefined : t(markets.length === 0 ? "noOtherMarkets" : "marketPrimaryNote"))}
              </Field>
              )}
              {kind === "segment" ? (
                <Field id="price-list-create-segment" label={t("segment")}>
                  <SearchableSelect
                    id="price-list-create-segment"
                    value={segmentId}
                    aria-invalid={problems.segment ? true : undefined}
                    aria-describedby="price-list-create-segment-note"
                    triggerClassName="block w-full"
                    options={segments.map((segment) => ({ value: segment.id, label: segment.name }))}
                    emptyMessage={t("segmentNone")}
                    onValueChange={(value) => {
                      setSegmentId(value);
                      if (problems.segment) setProblems((current) => ({ ...current, segment: undefined }));
                    }}
                  />
                  {note("segment", segments.length === 0 ? t("segmentNone") : undefined)}
                </Field>
              ) : null}
            </form>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="price-list-create-form" disabled={!choices.data} loading={create.isPending}>{t("create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
