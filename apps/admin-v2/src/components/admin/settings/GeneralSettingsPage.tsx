import { useEffect, useState, lazy, Suspense } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Loader2 } from "lucide-react";
import type { HeaderConfig } from "../header-builder/types";
import type { FooterConfig } from "../footer-builder/types";
import type { GeneralSettingsSection } from "./general-settings-sections";

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
  section: GeneralSettingsSection;
  onSectionChange: (section: GeneralSettingsSection) => void;
}

const tabs = [
  { value: "header", label: "Header" },
  { value: "footer", label: "Footer" },
  { value: "seo", label: "SEO" },
  { value: "storefront", label: "Storefront" },
  { value: "email", label: "Email" },
  { value: "currency", label: "Currency" },
  { value: "media", label: "Media" },
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
  section,
  onSectionChange,
}: GeneralSettingsPageProps) {
  const [mountedTabs, setMountedTabs] = useState<Set<string>>(
    () => new Set([section]),
  );

  useEffect(() => {
    setMountedTabs((prev) => {
      if (prev.has(section)) return prev;
      const next = new Set(prev);
      next.add(section);
      return next;
    });
  }, [section]);

  const handleTabChange = (value: string) => {
    onSectionChange(value as GeneralSettingsSection);
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
      <div className="mx-auto max-w-6xl">
        <div className="mb-4">
          <h1 className="text-xl font-semibold tracking-tight">
            General Settings
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Store identity, presentation, discovery, communication, and access.
          </p>
        </div>

        <Tabs
          value={section}
          onValueChange={handleTabChange}
          className="grid min-w-0 gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]"
        >
          <TabsList className="h-auto min-w-0 justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 [scrollbar-width:thin] lg:sticky lg:top-16 lg:flex-col lg:self-start lg:overflow-visible lg:rounded-md lg:border lg:bg-card lg:p-1">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="h-10 shrink-0 justify-start rounded-none border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-none hover:text-foreground data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none lg:w-full lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-muted"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-w-0">
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
