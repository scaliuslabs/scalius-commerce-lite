import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ChoiceField, Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { getServerFnError } from "~/lib/api-helpers";
import { saveCustomerTaxExemption } from "~/lib/api-mutations/customers";
import type { CustomerDto } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { useMessages } from "~/i18n";
import { customerTaxExemptionMessages } from "~/i18n/customer-tax-exemption";
import { resourceMessages } from "~/i18n/resource";

/** The longest exemption number the API accepts (`TAX_EXEMPTION_ID_MAX_LENGTH`). */
const EXEMPTION_NUMBER_MAX = 64;

/**
 * The customer page's Tax exemption card: a tax-exempt customer's orders pay
 * no tax and the optional exemption number (a VAT registration or resale
 * certificate) is printed on their invoices. Saves with its own button;
 * without the customers.edit permission it only shows the state.
 */
export function CustomerTaxExemptionCard({ customerId, taxExempt, taxExemptionId, canEdit }: {
  customerId: string;
  taxExempt: boolean;
  taxExemptionId: string | null;
  canEdit: boolean;
}) {
  const t = useMessages(customerTaxExemptionMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const [exempt, setExempt] = useState(taxExempt);
  const [number, setNumber] = useState(taxExemptionId ?? "");
  const dirty = exempt !== taxExempt || (exempt && number.trim() !== (taxExemptionId ?? ""));

  // A fresh read replaces the fields only while there are no edits.
  useEffect(() => {
    if (dirty) return;
    setExempt(taxExempt);
    setNumber(taxExemptionId ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taxExempt, taxExemptionId]);

  const save = useMutation({
    mutationFn: () => saveCustomerTaxExemption(customerId, {
      taxExempt: exempt,
      taxExemptionId: exempt ? number.trim() || null : null,
    }),
    onSuccess: (result) => {
      setExempt(result.taxExempt);
      setNumber(result.taxExemptionId ?? "");
      queryClient.setQueryData<CustomerDto>(queryKeys.customers.detail(customerId), (customer) =>
        customer ? { ...customer, ...result } : customer);
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.history(customerId) });
      toast.success(t("saved"));
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit ? (
          <>
            <ChoiceField
              id="customer-tax-exempt"
              label={t("taxExempt")}
              help={t("help")}
              control={(
                <Switch
                  id="customer-tax-exempt"
                  checked={exempt}
                  disabled={save.isPending}
                  aria-describedby="customer-tax-exempt-help"
                  onCheckedChange={setExempt}
                />
              )}
            />
            {exempt ? (
              <Field id="customer-tax-exemption-id" label={t("exemptionNumber")} optional help={t("exemptionNumberHelp")}>
                <Input
                  id="customer-tax-exemption-id"
                  value={number}
                  maxLength={EXEMPTION_NUMBER_MAX}
                  disabled={save.isPending}
                  autoComplete="off"
                  onChange={(event) => setNumber(event.target.value)}
                />
              </Field>
            ) : null}
            {save.isError ? (
              <p role="alert" className="text-body text-destructive">{getServerFnError(save.error, r("actionFailed"))}</p>
            ) : null}
            {dirty ? (
              <Button type="button" loading={save.isPending} onClick={() => save.mutate()}>{t("save")}</Button>
            ) : null}
          </>
        ) : (
          <div className="space-y-1">
            <p className="text-body font-medium">{t(taxExempt ? "stateExempt" : "stateNotExempt")}</p>
            {taxExempt && taxExemptionId ? (
              <p className="break-words text-body text-muted-foreground">{t("numberLabel", { number: taxExemptionId })}</p>
            ) : null}
            <p className="text-body text-muted-foreground">{t("help")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
