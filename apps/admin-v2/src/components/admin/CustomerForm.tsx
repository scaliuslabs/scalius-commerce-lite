import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { postApiV1AdminCustomers, putApiV1AdminCustomersById } from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "../ui/form";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { LocationSelector } from "./LocationSelector";
import { CustomerActivity } from "./CustomerActivity";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import { customerFormSchema, type CustomerFormValues } from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { customerTitle, type CustomerTitleInput } from "~/lib/customer-title";
import { readCustomerPhoneConflict, type CustomerPhoneConflict } from "~/lib/admin-api-error";
import { CustomerTrashNotice, type TrashedCustomer } from "./CustomerTrashNotice";

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>;
  isEdit?: boolean;
  /** The saved record being edited: titles the page (a guest record by its phone) and says if it's in Trash. */
  record?: CustomerTitleInput & TrashedCustomer & { deletedAt: unknown };
}

/** Under the phone field after a save: links the customer that already uses the number. */
export function PhoneUsedBy({ customer }: { customer: CustomerPhoneConflict }) {
  const t = useMessages(customersMessages);
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
    phone: values.phone,
    address: values.address,
    city: values.city,
    zone: values.zone,
    area: values.area,
  };
}

/**
 * The one customer page: contact and address on the side, orders and the
 * change log in the main column. Viewing needs customers.view; saving needs
 * customers.edit (or .create for a new customer); orders need view_history.
 */
export function CustomerForm({ defaultValues, isEdit = false, record }: CustomerFormProps) {
  const t = useMessages(customersMessages);
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  // A deleted record (in Trash, or merged into an account) opens read-only.
  const trashed = isEdit && Boolean(record?.deletedAt);
  const canSave = !trashed && (isEdit ? hasPermission(PERMISSIONS.CUSTOMERS_EDIT) : canCreate);
  const canViewHistory = isEdit && hasPermission(PERMISSIONS.CUSTOMERS_VIEW_HISTORY);
  const [phoneConflict, setPhoneConflict] = useState<CustomerPhoneConflict | null>(null);
  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      email: null,
      phone: "",
      address: null,
      city: null,
      zone: null,
      area: null,
      cityName: "",
      zoneName: "",
      areaName: "",
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CustomerFormValues>({
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => apiData(postApiV1AdminCustomers({ body: toCustomerInput(data) })),
    updateFn: (data) => apiData(putApiV1AdminCustomersById({ path: { id: data.id }, body: toCustomerInput(data) })),
    invalidateKeys: [queryKeys.customers.all, queryKeys.dashboard.all],
    onSuccess: (result) => {
      const id = (result as Partial<ApiResult<typeof postApiV1AdminCustomers>>).id || defaultValues?.id;
      form.reset({ ...form.getValues(), ...(id ? { id } : {}) });
      if (!isEdit && id) {
        void navigate({ to: "/admin/customers/$customerId/edit", params: { customerId: id }, replace: true });
      }
    },
    onError: (error) => {
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
        <CardContent className="space-y-3">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("name")}</FormLabel>
                <FormControl>
                  <Input required autoComplete="off" {...field} />
                </FormControl>
                {record?.kind === "guest" ? <FormDescription>{t("guestNameHint")}</FormDescription> : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("phone")}</FormLabel>
                <FormControl>
                  <AdminPhoneInput
                    value={field.value}
                    onChange={(value) => {
                      setPhoneConflict(null);
                      field.onChange(value);
                    }}
                    required
                  />
                </FormControl>
                <FormMessage />
                {phoneConflict ? <PhoneUsedBy customer={phoneConflict} /> : null}
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("email")}</FormLabel>
                <FormControl>
                  {/* Email is optional: clearing it removes it. */}
                  <Input
                    type="email"
                    {...field}
                    value={field.value || ""}
                    onChange={(event) => field.onChange(event.target.value.trim() ? event.target.value : null)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("address")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <FormField
            control={form.control}
            name="address"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("addressLine")}</FormLabel>
                <FormControl>
                  <Textarea rows={2} {...field} value={field.value || ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <LocationSelector />
          <input type="hidden" {...form.register("cityName")} />
          <input type="hidden" {...form.register("zoneName")} />
          <input type="hidden" {...form.register("areaName")} />
        </CardContent>
      </Card>
    </>
  );

  return (
    <FormContainer
      heading={isEdit ? (record ? customerTitle(record, t).title : t("customer")) : t("newCustomer")}
      unsavedLabel={isEdit ? undefined : t("unsavedCustomer")}
      savedMessage={t(isEdit ? "customerSaved" : "customerCreated")}
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
        <div className="mx-auto max-w-2xl space-y-4">{details}</div>
      )}
    </FormContainer>
  );
}
