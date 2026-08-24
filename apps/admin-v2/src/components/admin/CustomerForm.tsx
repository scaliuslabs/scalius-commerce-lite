import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
  type CreateCustomerPayload,
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
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const canCreate = hasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  const canSave = isEdit
    ? hasPermission(PERMISSIONS.CUSTOMERS_EDIT)
    : canCreate;
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
    onSuccess: (result) => {
      const id = (result as Partial<CreateCustomerPayload>).id || defaultValues?.id;
      form.reset({
        ...form.getValues(),
        ...(id ? { id } : {}),
      });
      toast.success(isEdit ? "Customer saved" : "Customer created");
      if (!isEdit && id) {
        void navigate({
          to: "/admin/customers/$customerId/edit",
          params: { customerId: id },
          replace: true,
        });
      }
    },
    onError: (_error, message) => {
      if (message.toLowerCase().includes("phone number already exists")) {
        const detail = "A customer already uses this phone number.";
        form.setError("phone", { type: "server", message: detail });
        toast.error("Phone number already in use", { description: detail });
        return true;
      }
      return false;
    },
  });

  const handleSubmit = (values: CustomerFormValues) => {
    submitEntity(values);
  };

  return (
    <FormContainer
      title="Customers"
      entityName={form.watch("name")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl="/admin/customers"
      newUrl="/admin/customers/new"
      newLabel="New customer"
      canCreateNew={canCreate}
      canSave={canSave}
      isFormValid={form.formState.isValid}
      saveLabel={isEdit ? "Save customer" : "Create customer"}
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
              <CardTitle className="text-base">Basic information</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Name<span className="text-destructive" aria-hidden="true"> *</span>
                      <span className="sr-only"> (required)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Enter customer name"
                        className="h-11 sm:h-9"
                        required
                        {...field}
                      />
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
                      <FormLabel>
                        Phone number<span className="text-destructive" aria-hidden="true"> *</span>
                        <span className="sr-only"> (required)</span>
                      </FormLabel>
                      <FormControl>
                        <AdminPhoneInput
                          value={field.value}
                          onChange={field.onChange}
                          preserveExistingValue={isEdit ? defaultValues?.phone : undefined}
                          required
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
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="Enter email address"
                          className="h-11 sm:h-9"
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
                    <FormLabel>Address</FormLabel>
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
