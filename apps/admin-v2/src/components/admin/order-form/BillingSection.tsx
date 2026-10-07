// The staff order's billing address (migration 0119): "Same as delivery
// address" for an order that ships, otherwise optional. An order that ships
// nothing is taxed in its billing country.
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { BillingAddressFields } from "~/components/admin/address/BillingAddressFields";
import type { AddressDraft, AddressProblemField } from "~/components/admin/address/address-draft";
import { useMessages } from "~/i18n";
import { addressMessages } from "~/i18n/address";

export function BillingSection(props: {
  ships: boolean;
  sameAsShipping: boolean;
  onSameAsShippingChange: (checked: boolean) => void;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors?: Partial<Record<AddressProblemField, string | undefined>>;
  disabled?: boolean;
}) {
  const t = useMessages(addressMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("billingTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <BillingAddressFields idPrefix="order-billing" hideLegend {...props} />
      </CardContent>
    </Card>
  );
}
