// The billing address of a staff order or an order edit (migration 0119,
// Shopify's draft orders): an order that ships is billed at its delivery
// address unless staff untick "Same as delivery address"; an order that ships
// nothing may have one (it is then taxed in its billing country). A billing
// address has no City → Thana picker: Bangladesh fills its canonical fields.
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { useMessages } from "~/i18n";
import { addressMessages } from "~/i18n/address";
import { AddressFields } from "./AddressFields";
import type { AddressDraft, AddressProblemField } from "./address-draft";

export function BillingAddressFields({
  idPrefix,
  ships,
  sameAsShipping,
  onSameAsShippingChange,
  value,
  onChange,
  errors,
  disabled,
  hideLegend = false,
}: {
  idPrefix: string;
  /** The section is already titled (a card): the legend is for screen readers only. */
  hideLegend?: boolean;
  /** The order delivers something: "Same as delivery address" is offered. */
  ships: boolean;
  sameAsShipping: boolean;
  onSameAsShippingChange: (checked: boolean) => void;
  value: AddressDraft;
  onChange: (next: AddressDraft) => void;
  errors?: Partial<Record<AddressProblemField, string | undefined>>;
  disabled?: boolean;
}) {
  const t = useMessages(addressMessages);
  const editing = !ships || !sameAsShipping;
  return (
    <fieldset className="grid gap-3" aria-describedby={ships ? undefined : `${idPrefix}-help`}>
      <legend className={hideLegend ? "sr-only" : "font-medium"}>{t("billingTitle")}</legend>
      {ships ? (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-same`}
            checked={sameAsShipping}
            disabled={disabled}
            onCheckedChange={(next) => onSameAsShippingChange(next === true)}
          />
          <Label htmlFor={`${idPrefix}-same`}>{t("billingSameAsShipping")}</Label>
        </div>
      ) : (
        <p id={`${idPrefix}-help`} className="text-body text-muted-foreground">{t("billingOptionalHelp")}</p>
      )}
      {editing ? (
        <AddressFields
          idPrefix={idPrefix}
          value={value}
          onChange={onChange}
          errors={errors}
          showRecipient
          canonicalOnly
          nameLabel={t("billingName")}
          disabled={disabled}
        />
      ) : null}
    </fieldset>
  );
}
