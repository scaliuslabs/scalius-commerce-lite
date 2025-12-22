import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { SubmitHandler } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Button } from "../ui/button";
import { Loader2 } from "lucide-react";
import { LocationSelector } from "./LocationSelector";

const customerFormSchema = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .min(3, "Name must be at least 3 characters")
    .max(100, "Name must be less than 100 characters"),
  email: z.string().email().nullable(),
  phone: z
    .string()
    .min(11, "Phone number must be at least 11 characters")
    .max(14, "Phone number must be less than 14 characters"),
  address: z
    .string()
    .max(500, "Address must be less than 500 characters")
    .nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
  cityName: z.string().optional(),
  zoneName: z.string().optional(),
  areaName: z.string().optional(),
});

type CustomerFormValues = z.infer<typeof customerFormSchema>;

interface CustomerFormProps {
  defaultValues?: Partial<CustomerFormValues>;
  isEdit?: boolean;
}

export function CustomerForm({
  defaultValues,
  isEdit = false,
}: CustomerFormProps) {
  console.log("CustomerForm received defaultValues:", defaultValues);
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
      // Only do this for edit mode

      // Force a rerender of the form after a short delay
      const timer = setTimeout(() => {
        console.log("Running manual initialization with values:", {
          city: defaultValues.city,
          zone: defaultValues.zone,
          area: defaultValues.area,
        });

        // First set city to trigger city dropdown to populate
        if (defaultValues.city) {
          form.setValue("city", defaultValues.city, { shouldDirty: false });
        }

        // Then wait a bit to set zone after city's useEffect has triggered
        setTimeout(() => {
          if (defaultValues.zone) {
            form.setValue("zone", defaultValues.zone, { shouldDirty: false });
          }

          // Then wait again to set area after zone's useEffect has triggered
          setTimeout(() => {
            if (defaultValues.area) {
              form.setValue("area", defaultValues.area, { shouldDirty: false });
            }
            setIsInitializing(false);
          }, 300);
        }, 300);
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [isEdit, defaultValues, isInitializing, form]);

  // Monitor location fields for debugging
  React.useEffect(() => {
    const subscription = form.watch((value, { name, type }) => {
      if (name === "city" || name === "zone" || name === "area") {
        console.log(`Field ${name} changed via ${type}:`, value[name]);
      }
    });

    return () => subscription.unsubscribe();
  }, [form]);

  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const handleSubmit: SubmitHandler<CustomerFormValues> = async (values) => {
    try {
      setIsSubmitting(true);
      const endpoint = isEdit
        ? `/api/customers/${values.id}`
        : "/api/customers";
      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(values),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to save customer");
      }

      await response.json();
      window.location.href = "/admin/customers";
    } catch (error) {
      console.error("Error submitting form:", error);
      alert("Failed to save customer. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
            <CardDescription>
              Enter the customer's basic details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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
                      <Input placeholder="Enter phone number" {...field} />
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

        <Card>
          <CardHeader>
            <CardTitle>Address Information</CardTitle>
            <CardDescription>
              Enter the customer's address details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
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

        <div className="flex justify-end">
          <Button
            type="submit"
            className="md:w-auto"
            disabled={isSubmitting || isInitializing}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isEdit ? "Updating..." : "Creating..."}
              </>
            ) : isInitializing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading location data...
              </>
            ) : (
              <>{isEdit ? "Update Customer" : "Create Customer"}</>
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
