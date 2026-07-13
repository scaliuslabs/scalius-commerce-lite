import { useEffect, useRef } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Check,
  Code2,
  ShieldCheck,
} from "lucide-react";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Checkbox } from "../ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { FormContainer } from "@/components/admin/shared/FormContainer";
import {
  analyticsFormSchema,
  type AnalyticsFormValues,
  type AnalyticsScriptType,
} from "@/lib/form-schemas";
import {
  createAnalyticsScript,
  updateAnalyticsScript,
} from "@/lib/api-functions/analytics";
import { useEntityFormSubmit } from "@/hooks/use-entity-form-submit";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { cn } from "@scalius/shared/utils";
import {
  OfficialProviderMark,
  type ProviderMarkId,
} from "@/components/admin/settings/provider-marks";

interface AnalyticsFormProps {
  defaultValues?: Partial<AnalyticsFormValues>;
  isEdit?: boolean;
}

const CONFIG_EXAMPLES: Record<AnalyticsScriptType, string> = {
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
  facebook_pixel: `<!-- Meta Pixel base code -->
<script>
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
  (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', 'PIXEL_ID'); fbq('track', 'PageView');
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
  cloudflare_web_analytics: "",
  custom: `<script>
  // This trusted code runs on every buyer page while active.
</script>`,
};

const PROVIDERS: Array<{
  type: AnalyticsScriptType;
  label: string;
  description: string;
  mark?: ProviderMarkId;
  icon?: typeof Code2;
  recommended?: boolean;
}> = [
  {
    type: "cloudflare_web_analytics",
    label: "Cloudflare Web Analytics",
    description: "Lightweight traffic and performance measurement.",
    mark: "cloudflare",
    recommended: true,
  },
  {
    type: "google_analytics",
    label: "Google Analytics 4",
    description: "GA4 reporting with a G- measurement ID.",
    mark: "google-analytics",
  },
  {
    type: "google_tag_manager",
    label: "Google Tag Manager",
    description: "Manage a GTM web container from one snippet.",
    mark: "google-tag-manager",
  },
  {
    type: "facebook_pixel",
    label: "Meta Pixel",
    description: "Browser events; pair with Meta CAPI settings.",
    mark: "meta",
  },
  {
    type: "tiktok_pixel",
    label: "TikTok Pixel",
    description: "Browser commerce measurement for TikTok.",
    mark: "tiktok",
  },
  {
    type: "custom",
    label: "Custom code",
    description: "Advanced trusted code for every buyer page.",
    icon: Code2,
  },
];

const providerLabel = (type: AnalyticsScriptType) =>
  PROVIDERS.find((provider) => provider.type === type)?.label ?? "Analytics";

export function AnalyticsForm({ defaultValues, isEdit = false }: AnalyticsFormProps) {
  const { hasPermission } = usePermissions();
  const canSave = isEdit
    ? hasPermission(PERMISSIONS.ANALYTICS_EDIT)
    : hasPermission(PERMISSIONS.ANALYTICS_CREATE);
  const canToggle = hasPermission(PERMISSIONS.ANALYTICS_TOGGLE);
  const defaultType = defaultValues?.type ?? "cloudflare_web_analytics";
  const form = useForm<AnalyticsFormValues>({
    resolver: zodResolver(analyticsFormSchema),
    defaultValues: {
      name: "",
      type: defaultType,
      isActive: false,
      usePartytown: defaultType !== "cloudflare_web_analytics",
      allowDuplicateProvider: false,
      config: CONFIG_EXAMPLES[defaultType],
      location: defaultType === "cloudflare_web_analytics" ? "body_end" : "head",
      ...defaultValues,
      ...(defaultType === "cloudflare_web_analytics" ? { usePartytown: false } : {}),
    },
  });

  const { isSubmitting, handleSubmit: submitEntity } = useEntityFormSubmit<AnalyticsFormValues>({
    entityName: "Analytics integration",
    isEdit,
    entityId: defaultValues?.id,
    createFn: (data) => createAnalyticsScript({ data }),
    updateFn: (data) => {
      if (!data.id || !data.expectedRevision) {
        throw new Error("Analytics revision is missing. Reload before saving.");
      }
      return updateAnalyticsScript({
        data: data as AnalyticsFormValues & { id: string; expectedRevision: number },
      });
    },
    invalidateKeys: [
      queryKeys.analytics.all,
      ...(isEdit && defaultValues?.id ? [queryKeys.analytics.detail(defaultValues.id)] : []),
    ],
    navigateTo: "/admin/analytics",
  });

  const previousSuggestion = useRef(CONFIG_EXAMPLES[defaultType]);
  useEffect(() => {
    const subscription = form.watch((value, context) => {
      if (context.name !== "type" || !value.type) return;
      const type = value.type as AnalyticsScriptType;
      const currentConfig = form.getValues("config");
      const nextSuggestion = CONFIG_EXAMPLES[type];
      if (!currentConfig || currentConfig === previousSuggestion.current) {
        form.setValue("config", nextSuggestion, { shouldDirty: true });
      }
      previousSuggestion.current = nextSuggestion;
      if (!form.getValues("name") || PROVIDERS.some((provider) => provider.label === form.getValues("name"))) {
        form.setValue("name", providerLabel(type), { shouldDirty: true });
      }
      if (type === "cloudflare_web_analytics") {
        form.setValue("usePartytown", false, { shouldDirty: true });
        form.setValue("location", "body_end", { shouldDirty: true });
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  const selectedType = form.watch("type");
  const isActive = form.watch("isActive");
  const isCloudflare = selectedType === "cloudflare_web_analytics";
  const isCustom = selectedType === "custom";

  return (
    <FormContainer
      title={isEdit ? "Edit integration" : "New analytics integration"}
      entityName={form.watch("name")}
      isEdit={isEdit}
      isSubmitting={isSubmitting}
      backUrl="/admin/analytics"
      canSave={canSave}
      saveDisabledReason={isEdit
        ? "You do not have permission to edit analytics integrations."
        : "You do not have permission to create analytics integrations."}
      saveLabel={isEdit ? "Save changes" : "Create draft"}
      form={form}
      onSubmit={form.handleSubmit((values) => submitEntity({
        ...values,
        usePartytown: isCloudflare ? false : values.usePartytown,
      }))}
      formClassName="space-y-4"
    >
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <section className="rounded-lg border bg-background p-4">
            <div className="mb-3">
              <h2 className="text-sm font-semibold">Provider</h2>
              <p className="text-xs text-muted-foreground">
                Choose what this integration measures. It remains a draft until explicitly activated.
              </p>
            </div>
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {PROVIDERS.map((provider) => {
                        const Icon = provider.icon;
                        const selected = field.value === provider.type;
                        return (
                          <button
                            key={provider.type}
                            type="button"
                            onClick={() => field.onChange(provider.type)}
                            className={cn(
                              "relative min-h-20 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selected ? "border-foreground bg-muted/55" : "hover:bg-muted/35",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              {provider.mark ? (
                                <OfficialProviderMark provider={provider.mark} />
                              ) : Icon ? (
                                <Icon className="h-5 w-5" aria-hidden="true" />
                              ) : null}
                              {selected ? <Check className="h-4 w-4" /> : null}
                            </div>
                            <p className="mt-2 flex items-center gap-1.5 text-sm font-medium leading-tight">
                              {provider.label}
                              {provider.recommended ? (
                                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                                  Recommended
                                </span>
                              ) : null}
                            </p>
                            <p className="mt-1 text-xs leading-snug text-muted-foreground">{provider.description}</p>
                          </button>
                        );
                      })}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>

          <section className="rounded-lg border bg-background p-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Integration name</FormLabel>
                    <FormControl><Input placeholder={providerLabel(selectedType)} {...field} /></FormControl>
                    <FormDescription>Shown only to dashboard operators.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <ShieldCheck className="h-3.5 w-3.5" /> Draft-safe setup
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Saving does not publish tracking unless Active is enabled by an authorized operator.
                </p>
              </div>
            </div>

            <FormField
              control={form.control}
              name="config"
              render={({ field }) => (
                <FormItem className="mt-4">
                  <FormLabel>
                    {isCloudflare ? "Cloudflare site token" : isCustom ? "Trusted storefront code" : "Official provider snippet"}
                  </FormLabel>
                  <FormControl>
                    {isCloudflare ? (
                      <Input
                        className="font-mono"
                        placeholder="Paste the Web Analytics site token"
                        autoComplete="off"
                        {...field}
                      />
                    ) : (
                      <Textarea
                        className="min-h-52 resize-y font-mono text-xs leading-relaxed"
                        placeholder="Paste the complete provider snippet"
                        spellCheck={false}
                        {...field}
                      />
                    )}
                  </FormControl>
                  <FormDescription>
                    {isCloudflare
                      ? "The server validates the token and generates the canonical Cloudflare beacon."
                      : isCustom
                        ? "Custom code is trusted administrator code and runs on every buyer page while active."
                        : "Paste the complete base code from the provider dashboard. Activation is validated by the server."}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <section className="rounded-lg border bg-background p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Storefront status</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {canToggle
                    ? "Activation starts loading this integration on buyer pages."
                    : "Only operators with analytics toggle permission can change this."}
                </p>
              </div>
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        disabled={!canToggle}
                        onCheckedChange={field.onChange}
                        aria-label="Active on storefront"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            <div className={cn(
              "mt-3 rounded-md px-2.5 py-2 text-xs font-medium",
              isActive ? "bg-emerald-50 text-emerald-800" : "bg-muted text-muted-foreground",
            )}>
              {isActive ? "Active after save" : "Inactive draft"}
            </div>
            {isActive ? (
              <FormField
                control={form.control}
                name="allowDuplicateProvider"
                render={({ field }) => (
                  <FormItem className="mt-3 flex items-start gap-2 rounded-md border p-2.5">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                      />
                    </FormControl>
                    <div>
                      <FormLabel className="text-xs">Allow duplicate provider</FormLabel>
                      <FormDescription className="text-xs">
                        Confirm only when a second account is intentional; duplicate page views distort reports.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            ) : null}
          </section>

          <details className="rounded-lg border bg-background" open={!isCloudflare}>
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Delivery settings</summary>
            <div className="space-y-4 border-t p-4">
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document placement</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="head">Document head</SelectItem>
                        <SelectItem value="body_start">Body start</SelectItem>
                        <SelectItem value="body_end">Body end</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Use the provider recommendation. Cloudflare defaults to body end.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="usePartytown"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-3">
                    <div>
                      <FormLabel>Worker isolation</FormLabel>
                      <FormDescription>
                        {isCloudflare
                          ? "Cloudflare runs on the main thread for performance timing."
                          : "Move supported third-party scripts off the main UI thread."}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        disabled={isCloudflare}
                        onCheckedChange={field.onChange}
                        aria-label="Use worker isolation"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </details>
        </aside>
      </div>
    </FormContainer>
  );
}
