import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";
import { postApiV1AdminCustomers, putApiV1AdminCustomersById } from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { FormField } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { CustomerActivity } from "./CustomerActivity";
import { AddressFields, SkipAddressValidation, useAddressErrors } from "./address/AddressFields";
import {
  addressDraftInput,
  emptyAddressDraft,
  isAddressDraftEmpty,
  readAddressProblems,
  type AddressProblem,
} from "./address/address-draft";
import { CustomerAddressesCard } from "./customers/CustomerAddressesCard";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import { customerFormSchema, type CustomerFormValues } from "@/lib/customer-form-schema";
import type { CustomerDto } from "@/lib/api-query-options/customers";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { customerPageMessages } from "~/i18n/customer-page";
import { customerAddressesMessages } from "~/i18n/customer-addresses";
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";
import { readCustomerPhoneConflict, type CustomerPhoneConflict } from "~/lib/admin-api-conflicts";
import { CustomerTrashNotice, type TrashedCustomer } from "./CustomerTrashNotice";
import { CustomFieldsCard } from "./custom-fields/CustomFieldsCard";
import { AppActionsMenu } from "./apps/ui/AppActions";
import { AppResourceCards } from "./apps/ui/AppResourceCards";
import { CustomerMarketingCard } from "./customers/CustomerMarketingCard";
import { CustomerTagsCard } from "./customers/CustomerTagsCard";
import { Field } from "~/components/ui/field";
import { Page } from "~/components/admin/resource/Page";

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>;
  isEdit?: boolean;
  /**
   * The saved record being edited: titles the page (a guest record by its
   * phone), says if it's in Trash and carries its tags.
   */
  record?: CustomerTitleInput & TrashedCustomer & {
    deletedAt: unknown;
    tags?: readonly string[];
    addresses?: CustomerDto["addresses"];
  };
}

/** Under the phone field after a save: links the customer that already uses the number. */
export function PhoneUsedBy({ customer }: { customer: CustomerPhoneConflict }) {
  const t = useMessages(customerPageMessages);
  const [before, after] = t("phoneUsedBy").split("{name}");
  return (
    <p className="text-body">
      {before}
      <Link to="/admin/customers/$customerId/edit" params={{ customerId: customer.id }} className="text-link hover:underline">
        {customerTitle(customer, t).title}
      </Link>
      {after}
    </p>
  );
}

function toCustomerInput(values: CustomerFormValues): ApiBody<typeof postApiV1AdminCustomers> {
  return {
    name: values.name,
    email: values.email,
    // Empty: a customer without a phone (a new one only; a saved phone stays).
    phone: values.phone || null,
  };
}

function toCustomerUpdate(values: CustomerFormValues): ApiBody<typeof putApiV1AdminCustomersById> {
  return {
    name: values.name,
    email: values.email,
    ...(values.phone ? { phone: values.phone } : {}),
  };
}

/** A new customer: the contact and, when one was entered, the first address. */
function toNewCustomerInput(values: CustomerFormValues): ApiBody<typeof postApiV1AdminCustomers> {
  const address = values.address && !isAddressDraftEmpty(values.address) ? values.address : null;
  return {
    ...toCustomerInput(values),
    address: address
      ? { ...addressDraftInput(address), ...(values.skipAddressValidation ? { skipValidation: true } : {}) }
      : null,
  };
}

/**
 * The one customer page: contact and the address book on the side, orders
 * and the change log in the main column. Viewing needs customers.view; saving needs
 * customers.edit (or .create for a new customer); orders need view_history.
 */
export function CustomerForm({ defaultValues, isEdit = false, record }: CustomerFormProps) {
  const t = useMessages(customerPageMessages);
  const ta = useMessages(customerAddressesMessages);
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  // A deleted record (in Trash, or merged into an account) opens read-only.
  const trashed = isEdit && Boolean(record?.deletedAt);
  const canSave = !trashed && (isEdit ? hasPermission(PERMISSIONS.CUSTOMERS_EDIT) : canCreate);
  const canViewHistory = isEdit && hasPermission(PERMISSIONS.CUSTOMERS_VIEW_HISTORY);
  const [phoneConflict, setPhoneConflict] = useState<CustomerPhoneConflict | null>(null);
  const [addressProblems, setAddressProblems] = useState<AddressProblem[] | null>(null);
  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      email: null,
      phone: "",
      ...(isEdit ? {} : { address: emptyAddressDraft() }),
      ...defaultValues,
    },
  });

  // A saved phone can be changed, never removed; a new or phoneless customer may leave it empty.
  const phoneRequired = isEdit && Boolean(record?.phone);
  const address = useWatch({ control: form.control, name: "address" });
  const skipAddressValidation = useWatch({ control: form.control, name: "skipAddressValidation" }) ?? false;
  const addressErrors = useAddressErrors(addressProblems, address?.countryCode ?? "BD");

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CustomerFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => apiData(postApiV1AdminCustomers({ body: toNewCustomerInput(data) })),
    updateFn: (data) => apiData(putApiV1AdminCustomersById({ path: { id: data.id }, body: toCustomerUpdate(data) })),
    invalidateKeys: [queryKeys.customers.all, queryKeys.dashboard.all],
    onSuccess: (result) => {
      const id = (result as Partial<ApiResult<typeof postApiV1AdminCustomers>>).id;
      if (!isEdit && id) {
        void navigate({ to: "/admin/customers/$customerId/edit", params: { customerId: id }, replace: true });
      }
    },
    onError: (error) => {
      const refused = readAddressProblems(error);
      if (refused) {
        setAddressProblems(refused);
        return ta("addressInvalid");
      }
      const conflict = readCustomerPhoneConflict(error);
      if (!conflict) return undefined;
      setPhoneConflict(conflict);
      form.setError("phone", { type: "server", message: t("phoneTaken") });
      return t("phoneTaken");
    },
  });

  const details = (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("contact")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field, fieldState }) => (
              <Field label={t("name")} help={record?.kind === "guest" ? t("guestNameHint") : undefined} error={fieldState.error?.message}>
                <Input required autoComplete="off" {...field} />
              </Field>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field, fieldState }) => (
              <div className="flex flex-col gap-2">
                <Field label={t("phone")} help={phoneRequired ? undefined : t("phoneOptionalHint")} error={fieldState.error?.message}>
                  <AdminPhoneInput
                    value={field.value}
                    onChange={(value) => {
                      setPhoneConflict(null);
                      field.onChange(value);
                    }}
                    required={phoneRequired}
                  />
                </Field>
                {phoneConflict ? <PhoneUsedBy customer={phoneConflict} /> : null}
              </div>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field, fieldState }) => (
              <Field label={t("email")} error={fieldState.error?.message}>
                {/* Email is optional: clearing it removes it. */}
                <Input
                  type="email"
                  {...field}
                  value={field.value || ""}
                  onChange={(event) => field.onChange(event.target.value.trim() ? event.target.value : null)}
                />
              </Field>
            )}
          />
        </CardContent>
      </Card>
      {isEdit && defaultValues?.id ? (
        <CustomerAddressesCard customerId={defaultValues.id} addresses={record?.addresses ?? []} canEdit={canSave} />
      ) : address ? (
        <Card>
          <CardHeader>
            <CardTitle>{ta("firstAddress")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-body text-muted-foreground">{ta("firstAddressHelp")}</p>
            <AddressFields
              idPrefix="new-customer-address"
              value={address}
              onChange={(next) => form.setValue("address", next, { shouldDirty: true })}
              errors={addressErrors}
              showRecipient
            />
            {addressProblems ? (
              <SkipAddressValidation
                id="new-customer-address-skip"
                checked={skipAddressValidation}
                onCheckedChange={(checked) => form.setValue("skipAddressValidation", checked, { shouldDirty: true })}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {isEdit && defaultValues?.id && !trashed ? (
        <>
          <CustomerMarketingCard customerId={defaultValues.id} canEdit={canSave} />
          <CustomerTagsCard customerId={defaultValues.id} tags={record?.tags ?? []} canEdit={canSave} />
          <CustomFieldsCard ownerType="customer" ownerId={defaultValues.id} canEdit={canSave} />
        </>
      ) : null}
      {isEdit && defaultValues?.id && !trashed ? <AppResourceCards target="customer" id={defaultValues.id} /> : null}
    </>
  );

  return (
    <FormContainer
      heading={isEdit ? (record ? customerTitle(record, t).title : t("customer")) : t("newCustomer")}
      unsavedLabel={isEdit ? undefined : t("unsavedCustomer")}
      savedMessage={t(isEdit ? "customerSaved" : "customerCreated")}
      actions={isEdit && defaultValues?.id && !trashed ? <AppActionsMenu target="customer" id={defaultValues.id} /> : undefined}
      isSubmitting={isSubmitting}
      backUrl="/admin/customers"
      canSave={canSave}
      form={form}
      onSave={submitEntity}
      readOnlyNotice={trashed && record ? (
        <CustomerTrashNotice customer={record} canRestore={hasPermission(PERMISSIONS.CUSTOMERS_DELETE)} />
      ) : undefined}
    >
      {canViewHistory && defaultValues?.id ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <CustomerActivity customerId={defaultValues.id} />
          </div>
          <div className="space-y-4">{details}</div>
        </div>
      ) : (
        <Page width="task" className="space-y-4">{details}</Page>
      )}
    </FormContainer>
  );
}
