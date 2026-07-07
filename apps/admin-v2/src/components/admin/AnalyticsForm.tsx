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
  google_analytics: `<!-- Google Analytics 4 (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>`,
  google_tag_manager: `<!-- Google Tag Manager -->
<script>
  (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
  })(window,document,'script','dataLayer','GTM-XXXXXXX');
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
  tiktok_pixel: `<!-- TikTok Pixel Code -->
<script>
  !function (w, d, t) {
    w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];
    ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
    ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};
    for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);
    ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};
    ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=r;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};n=d.createElement("script");n.type="text/javascript";n.async=!0;n.src=r+"?sdkid="+e+"&lib="+t;e=d.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
    ttq.load('PIXEL_ID');
    ttq.page();
  }(window, document, 'ttq');
</script>`,
  cloudflare_web_analytics: CLOUDFLARE_WEB_ANALYTICS_EXAMPLE,
  custom: `<!-- Custom Script -->
<script>
  // Your custom script here
</script>`,
};

const suggestedConfigs = Object.values(ANALYTICS_CONFIG_EXAMPLES);

const ACTIVE_ANALYTICS_PLACEHOLDER_PATTERNS = [
  /\bG-X{4,}\b/i,
  /\bGTM-X{4,}\b/i,
  /\bPIXEL_ID\b/i,
  /\bYOUR_[A-Z0-9_]*PIXEL[A-Z0-9_]*ID\b/i,
  /\bYOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN\b/i,
];

const GA4_MEASUREMENT_ID_PATTERN = /\bG-[A-Z0-9]{4,32}\b/i;
const GOOGLE_TAG_MANAGER_ID_PATTERN = /\bGTM-[A-Z0-9]{4,32}\b/i;
const FACEBOOK_PIXEL_INIT_PATTERN =
  /\bfbq\s*\(\s*(['"])init\1\s*,\s*(['"])(\d{5,32})\2/i;
const TIKTOK_PIXEL_LOAD_PATTERN =
  /\bttq\.load\s*\(\s*(['"])([A-Z0-9_-]{6,64})\1/i;
const TIKTOK_PIXEL_EVENTS_URL_PATTERN =
  /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/i;
const TIKTOK_PIXEL_SDK_ID_PATTERN = /\bsdkid=([A-Z0-9_-]{6,64})\b/i;

function getConfigExample(type: AnalyticsScriptType) {
  return ANALYTICS_CONFIG_EXAMPLES[type] ?? ANALYTICS_CONFIG_EXAMPLES.custom;
}

function hasGa4GtagSignal(config: string) {
  return (
    /\bgtag\s*\(/i.test(config) ||
    /googletagmanager\.com\/gtag\/js\?/i.test(config) ||
    /\bgtag\.js\b/i.test(config)
  );
}

function hasTikTokPixelLoadSignal(config: string) {
  return (
    TIKTOK_PIXEL_LOAD_PATTERN.test(config) ||
    (TIKTOK_PIXEL_EVENTS_URL_PATTERN.test(config) &&
      TIKTOK_PIXEL_SDK_ID_PATTERN.test(config))
  );
}

function getActiveAnalyticsConfigError(values: AnalyticsFormValues) {
  if (!values.isActive) {
    return null;
  }

  if (
    ACTIVE_ANALYTICS_PLACEHOLDER_PATTERNS.some((pattern) =>
      pattern.test(values.config),
    )
  ) {
    return "Replace placeholder IDs before activating this analytics script.";
  }

  switch (values.type) {
    case "google_analytics":
      if (
        !GA4_MEASUREMENT_ID_PATTERN.test(values.config) ||
        !hasGa4GtagSignal(values.config)
      ) {
        return "Active Google Analytics scripts must use a GA4 gtag.js snippet with a G- measurement ID, not a GTM container snippet.";
      }
      return null;
    case "google_tag_manager":
      if (!GOOGLE_TAG_MANAGER_ID_PATTERN.test(values.config)) {
        return "Active Google Tag Manager scripts must include a GTM- container ID.";
      }
      return null;
    case "facebook_pixel":
      if (!FACEBOOK_PIXEL_INIT_PATTERN.test(values.config)) {
        return "Active Facebook Pixel scripts must include a readable numeric fbq('init', '...') Pixel ID.";
      }
      return null;
    case "tiktok_pixel":
      if (!hasTikTokPixelLoadSignal(values.config)) {
        return "Active TikTok Pixel scripts must include the official Pixel load call, such as ttq.load('...').";
      }
      return null;
    default:
      return null;
  }
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
    const activeConfigError = getActiveAnalyticsConfigError(values);
    if (activeConfigError) {
      form.setError("config", {
        type: "validate",
        message: activeConfigError,
      });
      form.setFocus("config");
      return;
    }

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
  const isGoogleAnalytics = selectedType === "google_analytics";
  const isGoogleTagManager = selectedType === "google_tag_manager";
  const isTikTokPixel = selectedType === "tiktok_pixel";
  const namePlaceholder = isGoogleTagManager
    ? "Google Tag Manager"
    : isGoogleAnalytics
      ? "Google Analytics 4"
      : isTikTokPixel
        ? "TikTok Pixel"
        : "Analytics Script";
  const locationDescription = isCloudflareWebAnalytics
    ? "Cloudflare recommends installing the beacon before the closing body tag."
    : isGoogleTagManager
      ? "Google recommends the GTM script in the head. Add the optional noscript iframe separately at Body Start if needed."
      : "Where in the HTML document to place this script.";
  const configDescription = isCloudflareWebAnalytics
    ? "Paste the Cloudflare Web Analytics site token or the official beacon snippet."
    : isGoogleAnalytics
      ? "Paste the GA4 gtag.js snippet that uses a G- measurement ID, not a GTM container snippet."
      : isGoogleTagManager
        ? "Paste the Google Tag Manager web container script that uses a GTM- container ID. Add the noscript iframe as a separate Body Start custom script if needed."
        : isTikTokPixel
          ? "Paste the TikTok Pixel base code that loads your PIXEL_ID and calls ttq.page()."
          : "The actual script code that will be inserted into your site.";

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
                  <Input placeholder={namePlaceholder} {...field} />
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
                      Google Analytics 4 (gtag.js)
                    </SelectItem>
                    <SelectItem value="google_tag_manager">
                      Google Tag Manager
                    </SelectItem>
                    <SelectItem value="facebook_pixel">
                      Facebook Pixel
                    </SelectItem>
                    <SelectItem value="tiktok_pixel">
                      TikTok Pixel
                    </SelectItem>
                    <SelectItem value="cloudflare_web_analytics">
                      Cloudflare Web Analytics
                    </SelectItem>
                    <SelectItem value="custom">Custom Script</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  Use Google Analytics for GA4 snippets with G- measurement IDs,
                  Google Tag Manager for GTM containers with GTM- IDs, or
                  TikTok Pixel for browser commerce events.
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
                  {locationDescription}
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
                  {configDescription}
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
