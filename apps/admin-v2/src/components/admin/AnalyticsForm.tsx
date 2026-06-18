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
import {
  analyticsFormSchema,
  type AnalyticsFormValues,
  type AnalyticsScriptType,
} from "@/lib/form-schemas";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";

interface AnalyticsFormProps {
  defaultValues?: Partial<AnalyticsFormValues>;
  isEdit?: boolean;
}

const CLOUDFLARE_WEB_ANALYTICS_EXAMPLE =
  `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN"}'></script>`;

const ANALYTICS_CONFIG_EXAMPLES: Record<AnalyticsScriptType, string> = {
  google_analytics: `<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>`,
  facebook_pixel: `<!-- Facebook Pixel Code -->
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
</script>`,
  cloudflare_web_analytics: CLOUDFLARE_WEB_ANALYTICS_EXAMPLE,
  custom: `<!-- Custom Script -->
<script>
  // Your custom script here
</script>`,
};

const suggestedConfigs = Object.values(ANALYTICS_CONFIG_EXAMPLES);

function getConfigExample(type: AnalyticsScriptType) {
  return ANALYTICS_CONFIG_EXAMPLES[type] ?? ANALYTICS_CONFIG_EXAMPLES.custom;
}

export function AnalyticsForm({
  defaultValues,
  isEdit = false,
}: AnalyticsFormProps) {
  const defaultType = defaultValues?.type ?? "custom";
  const form = useForm<AnalyticsFormValues>({
    resolver: zodResolver(analyticsFormSchema),
    defaultValues: {
      name: "",
      type: defaultType,
      isActive: true,
      usePartytown:
        defaultType === "cloudflare_web_analytics"
          ? false
          : (defaultValues?.usePartytown ?? true),
      config: "",
      location:
        defaultType === "cloudflare_web_analytics"
          ? "body_end"
          : (defaultValues?.location ?? "head"),
      ...defaultValues,
      ...(defaultType === "cloudflare_web_analytics"
        ? { usePartytown: false, location: defaultValues?.location ?? "body_end" }
        : {}),
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
    submitEntity({
      ...values,
      usePartytown:
        values.type === "cloudflare_web_analytics" ? false : values.usePartytown,
    });
  };

  const lastSuggestedConfigRef = React.useRef<string | null>(null);

  // Update config example when type changes
  React.useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name === "type" && value.type) {
        const nextType = value.type as AnalyticsScriptType;
        const currentConfig = form.getValues("config");
        const previousSuggestion = lastSuggestedConfigRef.current;
        const nextSuggestion = getConfigExample(nextType);
        if (
          !currentConfig ||
          currentConfig === previousSuggestion ||
          suggestedConfigs.includes(currentConfig)
        ) {
          form.setValue("config", nextSuggestion, {
            shouldValidate: true,
          });
        }
        lastSuggestedConfigRef.current = nextSuggestion;

        if (nextType === "cloudflare_web_analytics") {
          form.setValue("usePartytown", false, { shouldValidate: true });
          form.setValue("location", "body_end", { shouldValidate: true });
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const selectedType = form.watch("type");
  const isCloudflareWebAnalytics =
    selectedType === "cloudflare_web_analytics";

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
                    <SelectItem value="cloudflare_web_analytics">
                      Cloudflare Web Analytics
                    </SelectItem>
                    <SelectItem value="custom">Custom Script</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Choose the provider this script belongs to.
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
                  {isCloudflareWebAnalytics
                    ? " Cloudflare recommends installing the beacon before the closing body tag."
                    : ""}
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
                  {isCloudflareWebAnalytics
                    ? "Paste the Cloudflare Web Analytics site token or the official beacon snippet."
                    : "The actual script code that will be inserted into your site."}
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
                    {isCloudflareWebAnalytics
                      ? "Cloudflare's beacon runs on the main thread so it can read browser performance timing."
                      : "Run this script in a web worker to improve page performance."}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    disabled={isCloudflareWebAnalytics}
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
