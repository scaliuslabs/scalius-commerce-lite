import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { LocationSelector } from "./LocationSelector";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import {
  createCustomer,
  updateCustomer,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from "@/lib/api-functions/customers";
import { customerFormSchema, type CustomerFormValues } from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { AdminPhoneInput } from "@/components/admin/shared/AdminPhoneInput";

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>;
  isEdit?: boolean;
}

function toCreateCustomerInput(values: CustomerFormValues): CreateCustomerInput {
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

function toUpdateCustomerInput(
  values: CustomerFormValues & { id: string },
): UpdateCustomerInput {
  return {
    id: values.id,
    ...toCreateCustomerInput(values),
  };
}

export function CustomerForm({
  defaultValues,
  isEdit = false,
}: CustomerFormProps) {
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  const canSave = isEdit
    ? hasPermission(PERMISSIONS.CUSTOMERS_EDIT)
    : canCreate;
  const [isInitializing, setIsInitializing] = React.useState(
    isEdit &&
      defaultValues &&
      (Boolean(defaultValues.city) ||
        Boolean(defaultValues.zone) ||
        Boolean(defaultValues.area)),
  );

  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
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

  // Trigger a manual form update to help with initialization of dependent fields
  React.useEffect(() => {
    if (isEdit && defaultValues && isInitializing) {
      let cancelled = false;

      const initFields = async () => {
        // Set city to trigger city dropdown to populate
        if (defaultValues.city) {
          form.setValue("city", defaultValues.city, { shouldDirty: false });
        }
        // Wait for city's useEffect to trigger zone list load
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;

        if (defaultValues.zone) {
          form.setValue("zone", defaultValues.zone, { shouldDirty: false });
        }
        // Wait for zone's useEffect to trigger area list load
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;

        if (defaultValues.area) {
          form.setValue("area", defaultValues.area, { shouldDirty: false });
        }
        // Wait for area to settle
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;

        setIsInitializing(false);
      };

      initFields();
      return () => { cancelled = true; };
    }
  }, [isEdit, defaultValues, isInitializing, form]);

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<CustomerFormValues>({
    entityName: "Customer",
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => createCustomer({ data: toCreateCustomerInput(data) }),
    updateFn: (data) => {
      if (!data.id) throw new Error("Customer ID is required for updates");
      const updateData = { ...data, id: data.id };
      return updateCustomer({
        data: toUpdateCustomerInput(updateData),
      });
    },
    invalidateKeys: [
      queryKeys.customers.list(),
      queryKeys.dashboard.all,
      ...(isEdit && defaultValues?.id ? [queryKeys.customers.detail(defaultValues.id)] : []),
    ],
    navigateTo: "/admin/customers",
  });

  const handleSubmit = (values: CustomerFormValues) => {
    submitEntity(values);
  };

  return (
    <FormContainer
      title="Customers"
      entityName={form.watch("name")}
      isEdit={isEdit}
      isSubmitting={isSubmitting || !!isInitializing}
      backUrl="/admin/customers"
      newUrl="/admin/customers/new"
      newLabel="New Customer"
      canCreateNew={canCreate}
      canSave={canSave}
      saveDisabledReason={isEdit
        ? "You do not have permission to edit customers."
        : "You do not have permission to create customers."}
      form={form}
      onSubmit={form.handleSubmit(handleSubmit)}
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-5">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-base">Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Enter customer name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number</FormLabel>
                      <FormControl>
                        <AdminPhoneInput
                          value={field.value}
                          onChange={field.onChange}
                          preserveExistingValue={isEdit ? defaultValues?.phone : undefined}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email (Optional)</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="Enter email address"
                          {...field}
                          value={field.value || ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-3 pt-4 px-4">
              <CardTitle className="text-base">Address</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Enter address"
                        className="h-20"
                        {...field}
                        value={field.value || ""}
                      />
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
        </div>
      </div>
    </FormContainer>
  );
}
