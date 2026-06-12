import React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  FormControl,
  FormDescription,
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
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  createAnalyticsScript,
  updateAnalyticsScript,
} from "@/lib/api-functions/analytics";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import { analyticsFormSchema, type AnalyticsFormValues } from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";

interface AnalyticsFormProps {
  defaultValues?: Partial<AnalyticsFormValues>;
  isEdit?: boolean;
}

export function AnalyticsForm({
  defaultValues,
  isEdit = false,
}: AnalyticsFormProps) {
  const form = useForm<AnalyticsFormValues>({
    resolver: zodResolver(analyticsFormSchema),
    defaultValues: {
      name: "",
      type: "custom",
      isActive: true,
      usePartytown: true,
      config: "",
      location: "head",
      ...defaultValues,
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<AnalyticsFormValues>({
    entityName: "Analytics Script",
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => createAnalyticsScript({ data: data as unknown as Record<string, unknown> }),
    updateFn: (data) => updateAnalyticsScript({ data: data as Record<string, unknown> & { id: string } }),
    invalidateKeys: [
      queryKeys.analytics.list(),
      ...(isEdit && defaultValues?.id ? [queryKeys.analytics.detail(defaultValues.id)] : []),
    ],
    navigateTo: "/admin/analytics",
  });

  const handleSubmit = (values: AnalyticsFormValues) => {
    submitEntity(values);
  };

  // Helper function to show example config based on type
  const getConfigExample = (type: string) => {
    switch (type) {
      case "google_analytics":
        return `<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>`;
      case "facebook_pixel":
        return `<!-- Facebook Pixel Code -->
<script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', 'PIXEL_ID');
  fbq('track', 'PageView');
</script>`;
      default:
        return `<!-- Custom Script -->
<script>
  // Your custom script here
</script>`;
    }
  };

  // Update config example when type changes
  React.useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === "type" && value.type) {
        const currentConfig = form.getValues("config");
        if (
          !currentConfig ||
          currentConfig === getConfigExample(form.getValues("type") as string)
        ) {
          form.setValue("config", getConfigExample(value.type as string), {
            shouldValidate: true,
          });
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  return (
    <FormContainer
      title="Analytics"
      entityName={form.watch("name")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl="/admin/analytics"
      saveLabel={isEdit ? "Update Script" : "Add Script"}
      form={form}
      onSubmit={form.handleSubmit(handleSubmit)}
      formClassName="space-y-8"
    >
      <Card>
        <CardHeader>
          <CardTitle>Analytics Script</CardTitle>
          <CardDescription>
            Configure an analytics script to track user behavior on your site.
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
                  <Input placeholder="Google Analytics" {...field} />
                </FormControl>
                <FormDescription>
                  A descriptive name for this analytics script.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a script type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="rounded-xl bg-background">
                    <SelectItem value="google_analytics">
                      Google Analytics
                    </SelectItem>
                    <SelectItem value="facebook_pixel">
                      Facebook Pixel
                    </SelectItem>
                    <SelectItem value="custom">Custom Script</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  The type of analytics script you want to add.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a location" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="rounded-xl bg-background">
                    <SelectItem value="head">
                      Head (Before closing head tag)
                    </SelectItem>
                    <SelectItem value="body_start">
                      Body Start (After opening body tag)
                    </SelectItem>
                    <SelectItem value="body_end">
                      Body End (Before closing body tag)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Where in the HTML document to place this script.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Script Configuration</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Paste your script code here"
                    className="font-mono h-60"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  The actual script code that will be inserted into your site.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">Active Status</FormLabel>
                  <FormDescription>
                    Enable or disable this analytics script
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="usePartytown"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">Use Partytown</FormLabel>
                  <FormDescription>
                    Run this script in a web worker to improve page
                    performance
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
