import { useState, lazy, Suspense } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Loader2 } from "lucide-react";
import type { HeaderConfig } from "../header-builder/types";
import type { FooterConfig } from "../footer-builder/types";

const HeaderBuilder = lazy(() =>
  import("../header-builder").then((m) => ({
    default: m.HeaderBuilder,
  })),
);
const FooterBuilder = lazy(() =>
  import("../footer-builder").then((m) => ({
    default: m.FooterBuilder,
  })),
);
const SeoSettingsBuilder = lazy(() =>
  import("../SeoSettingsBuilder").then((m) => ({
    default: m.SeoSettingsBuilder,
  })),
);
const StorefrontUrlBuilder = lazy(() =>
  import("../StorefrontUrlBuilder").then((m) => ({
    default: m.StorefrontUrlBuilder,
  })),
);
const SecuritySettingsBuilder = lazy(() =>
  import("../SecuritySettingsBuilder").then((m) => ({
    default: m.SecuritySettingsBuilder,
  })),
);
const EmailSettingsForm = lazy(() => import("./EmailSettingsForm"));
const AuthSettingsBuilder = lazy(() => import("./AuthSettingsBuilder"));
const CurrencySettingsBuilder = lazy(() => import("./CurrencySettingsBuilder"));
const MediaSettingsBuilder = lazy(() => import("./MediaSettingsBuilder"));
const WidgetAiSettingsBuilder = lazy(() => import("./WidgetAiSettingsBuilder"));
const AllowedCountriesBuilder = lazy(() => import("./AllowedCountriesBuilder"));
const ScannerTokenGenerator = lazy(() =>
  import("./ScannerTokenGenerator").then((m) => ({
    default: m.ScannerTokenGenerator,
  })),
);
const BusinessSettingsBuilder = lazy(() => import("./BusinessSettingsBuilder"));
const NotificationChannelsBuilder = lazy(
  () => import("./NotificationChannelsBuilder"),
);

function TabSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

interface GeneralSettingsPageProps {
  headerConfig?: HeaderConfig | null;
  footerConfig?: FooterConfig | null;
}

const tabs = [
  { value: "header", label: "Header" },
  { value: "footer", label: "Footer" },
  { value: "seo", label: "SEO" },
  { value: "storefront", label: "Storefront" },
  { value: "email", label: "Email" },
  { value: "currency", label: "Currency" },
  { value: "media", label: "Media" },
  { value: "widget-ai", label: "Widget AI" },
  { value: "business", label: "Business" },
  { value: "countries", label: "Countries" },
  { value: "auth", label: "Auth & Access" },
  { value: "security", label: "Security" },
  { value: "scanner", label: "Scanner" },
  { value: "notification-channels", label: "Notifications" },
] as const;

export default function GeneralSettingsPage({
  headerConfig,
  footerConfig,
}: GeneralSettingsPageProps) {
  const [activeTab, setActiveTab] = useState("header");
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(
    () => new Set(["header"]),
  );

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setMountedTabs((prev) => {
      if (prev.has(value)) return prev;
      const next = new Set(prev);
      next.add(value);
      return next;
    });
  };

  return (
    <ErrorBoundary
      fallback={
        <div className="p-4 text-center text-muted-foreground">
          Something went wrong loading settings.{" "}
          <button
            onClick={() => window.location.reload()}
            className="underline"
          >
            Reload
          </button>
        </div>
      }
    >
      <div className="max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">
            General Settings
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Appearance, SEO, storefront, email delivery, authentication, and
            security.
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent p-0 h-auto flex-wrap gap-0">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="mt-6">
            <TabsContent value="header" className="mt-0">
              {mountedTabs.has("header") && (
                <Suspense fallback={<TabSpinner />}>
                  <HeaderBuilder initialConfig={headerConfig} />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="footer" className="mt-0">
              {mountedTabs.has("footer") && (
                <Suspense fallback={<TabSpinner />}>
                  <FooterBuilder initialConfig={footerConfig} />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="seo" className="mt-0">
              {mountedTabs.has("seo") && (
                <Suspense fallback={<TabSpinner />}>
                  <SeoSettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="storefront" className="mt-0">
              {mountedTabs.has("storefront") && (
                <Suspense fallback={<TabSpinner />}>
                  <StorefrontUrlBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="email" className="mt-0">
              {mountedTabs.has("email") && (
                <Suspense fallback={<TabSpinner />}>
                  <EmailSettingsForm />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="currency" className="mt-0">
              {mountedTabs.has("currency") && (
                <Suspense fallback={<TabSpinner />}>
                  <CurrencySettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="media" className="mt-0">
              {mountedTabs.has("media") && (
                <Suspense fallback={<TabSpinner />}>
                  <MediaSettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="widget-ai" className="mt-0">
              {mountedTabs.has("widget-ai") && (
                <Suspense fallback={<TabSpinner />}>
                  <WidgetAiSettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="business" className="mt-0">
              {mountedTabs.has("business") && (
                <Suspense fallback={<TabSpinner />}>
                  <BusinessSettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="countries" className="mt-0">
              {mountedTabs.has("countries") && (
                <Suspense fallback={<TabSpinner />}>
                  <AllowedCountriesBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="auth" className="mt-0">
              {mountedTabs.has("auth") && (
                <Suspense fallback={<TabSpinner />}>
                  <AuthSettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="security" className="mt-0">
              {mountedTabs.has("security") && (
                <Suspense fallback={<TabSpinner />}>
                  <SecuritySettingsBuilder />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="scanner" className="mt-0">
              {mountedTabs.has("scanner") && (
                <Suspense fallback={<TabSpinner />}>
                  <ScannerTokenGenerator />
                </Suspense>
              )}
            </TabsContent>

            <TabsContent value="notification-channels" className="mt-0">
              {mountedTabs.has("notification-channels") && (
                <Suspense fallback={<TabSpinner />}>
                  <NotificationChannelsBuilder />
                </Suspense>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </ErrorBoundary>
  );
}
