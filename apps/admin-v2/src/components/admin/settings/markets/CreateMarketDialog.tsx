// Add a market: its name and countries. It starts as a draft; the merchant
// sets its web presence and makes it active on its own page, where the
// dialog leads.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { MARKET_NAME_MAX_LENGTH } from "@scalius/shared/markets";
import { toast } from "~/lib/toast";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { useSubmitOnce } from "~/components/admin/shared/use-submit-once";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useMessages } from "~/i18n";
import { settingsMarketsMessages, type SettingsMarketsMessageKey } from "~/i18n/settings-markets";
import { getServerFnError } from "~/lib/api-helpers";
import { useCreateMarket } from "~/lib/api-query-options/markets";
import { MarketCountryPicker } from "./MarketCountryPicker";
import { createMarketBody } from "./market-form";

export function CreateMarketDialog({ open, onOpenChange, taken }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: ReadonlyMap<string, string>;
}) {
  const t = useMessages(settingsMarketsMessages);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<"name" | "countries", SettingsMarketsMessageKey>>>({});
  const create = useCreateMarket();
  const submitOnce = useSubmitOnce();
  const reset = create.reset;

  useEffect(() => {
    if (!open) return;
    setName("");
    setCountries([]);
    setErrors({});
    reset();
  }, [open, reset]);

  const dirty = name.trim() !== "" || countries.length > 0;
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: create.isPending, onClose: () => onOpenChange(false) });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problems: typeof errors = {};
    if (!name.trim()) problems.name = "nameRequired";
    if (countries.length === 0) problems.countries = "countriesRequired";
    setErrors(problems);
    if (problems.name || problems.countries) {
      document.getElementById(problems.name ? "market-create-name" : "market-create-countries")?.focus();
      return;
    }
    // One request at a time: a double click must not add the market twice.
    submitOnce(async () => {
      const market = await create.mutateAsync(createMarketBody(name, countries));
      toast.success(t("created"));
      onOpenChange(false);
      await navigate({ to: "/admin/settings/markets/$marketId", params: { marketId: market.id } });
    });
  };

  const serverError = create.error ? getServerFnError(create.error, t("createFailed")) : null;
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("addTitle")}</DialogTitle>
            <DialogDescription>{t("newMarketDraft")}</DialogDescription>
          </DialogHeader>
          <form id="market-create-form" method="post" noValidate className="space-y-4" onSubmit={submit}>
            {serverError ? <Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert> : null}
            <div className="space-y-1.5">
              <Label htmlFor="market-create-name">{t("name")}</Label>
              <Input
                id="market-create-name"
                value={name}
                maxLength={MARKET_NAME_MAX_LENGTH}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby="market-create-name-note"
                onChange={(event) => {
                  setName(event.target.value);
                  if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
                }}
              />
              <p id="market-create-name-note" className={errors.name ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                {t(errors.name ?? "nameHelp")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="market-create-countries">{t("countries")}</Label>
              <MarketCountryPicker
                id="market-create-countries"
                selected={countries}
                taken={taken}
                invalid={Boolean(errors.countries)}
                describedBy={errors.countries ? "market-create-countries-note" : undefined}
                onChange={(next) => {
                  setCountries(next);
                  if (errors.countries) setErrors((current) => ({ ...current, countries: undefined }));
                }}
              />
              {errors.countries ? (
                <p id="market-create-countries-note" className="text-body text-destructive">{t(errors.countries)}</p>
              ) : null}
            </div>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={create.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="market-create-form" loading={create.isPending}>{t("create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
