import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Loader2 } from "lucide-react";
import type {
  HeaderBuilderPanel,
  HeaderConfig,
} from "../header-builder/types";
import type {
  FooterBuilderPanel,
  FooterConfig,
} from "../footer-builder/types";
import type {
  GeneralSettingsPanel,
  GeneralSettingsSection,
} from "./general-settings-sections";
import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";

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
function TabSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function SettingsEditorBoundary({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <p className="font-medium">{label} settings could not be opened.</p>
          <p className="mt-1 text-muted-foreground">
            Other settings remain available. Reload the page to try this editor
            again.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 font-medium underline underline-offset-4"
          >
            Reload page
          </button>
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}

interface GeneralSettingsPageProps {
  headerConfig?: HeaderConfig | null;
  footerConfig?: FooterConfig | null;
  headerRevision?: number;
  footerRevision?: number;
  headerReadiness?: NavigationConfigSectionReadiness;
  footerReadiness?: NavigationConfigSectionReadiness;
  panel?: GeneralSettingsPanel;
  section: GeneralSettingsSection;
  onPanelChange: (panel: GeneralSettingsPanel) => void;
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
  { value: "auth", label: "Auth & access" },
  { value: "security", label: "Security" },
  { value: "scanner", label: "Scanner" },
] as const;

export default function GeneralSettingsPage({
  headerConfig,
  footerConfig,
  headerRevision,
  footerRevision,
  headerReadiness,
  footerReadiness,
  panel,
  section,
  onPanelChange,
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
  const headerPanel = section === "header"
    ? (panel as HeaderBuilderPanel | undefined)
    : undefined;
  const footerPanel = section === "footer"
    ? (panel as FooterBuilderPanel | undefined)
    : undefined;

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
            General settings
          </h1>
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
                className="h-11 shrink-0 justify-start rounded-none border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-none hover:text-foreground data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none sm:h-10 lg:w-full lg:rounded-sm lg:border-b-0 lg:data-[state=active]:bg-muted"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-w-0">
            <TabsContent value="header" className="mt-0">
              <SettingsEditorBoundary label="Header">
                {mountedTabs.has("header") && (
                  <Suspense fallback={<TabSpinner />}>
                    <HeaderBuilder
                      activePanel={headerPanel}
                      initialConfig={headerConfig}
                      initialRevision={headerRevision}
                      readiness={headerReadiness}
                      onPanelChange={onPanelChange}
                    />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="footer" className="mt-0">
              <SettingsEditorBoundary label="Footer">
                {mountedTabs.has("footer") && (
                  <Suspense fallback={<TabSpinner />}>
                    <FooterBuilder
                      activePanel={footerPanel}
                      initialConfig={footerConfig}
                      initialRevision={footerRevision}
                      readiness={footerReadiness}
                      onPanelChange={onPanelChange}
                    />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="seo" className="mt-0">
              <SettingsEditorBoundary label="SEO">
                {mountedTabs.has("seo") && (
                  <Suspense fallback={<TabSpinner />}>
                    <SeoSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="storefront" className="mt-0">
              <SettingsEditorBoundary label="Storefront">
                {mountedTabs.has("storefront") && (
                  <Suspense fallback={<TabSpinner />}>
                    <StorefrontUrlBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="email" className="mt-0">
              <SettingsEditorBoundary label="Email">
                {mountedTabs.has("email") && (
                  <Suspense fallback={<TabSpinner />}>
                    <EmailSettingsForm />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="currency" className="mt-0">
              <SettingsEditorBoundary label="Currency">
                {mountedTabs.has("currency") && (
                  <Suspense fallback={<TabSpinner />}>
                    <CurrencySettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="media" className="mt-0">
              <SettingsEditorBoundary label="Media">
                {mountedTabs.has("media") && (
                  <Suspense fallback={<TabSpinner />}>
                    <MediaSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="business" className="mt-0">
              <SettingsEditorBoundary label="Business">
                {mountedTabs.has("business") && (
                  <Suspense fallback={<TabSpinner />}>
                    <BusinessSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="countries" className="mt-0">
              <SettingsEditorBoundary label="Countries">
                {mountedTabs.has("countries") && (
                  <Suspense fallback={<TabSpinner />}>
                    <AllowedCountriesBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="auth" className="mt-0">
              <SettingsEditorBoundary label="Auth & Access">
                {mountedTabs.has("auth") && (
                  <Suspense fallback={<TabSpinner />}>
                    <AuthSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="security" className="mt-0">
              <SettingsEditorBoundary label="Security">
                {mountedTabs.has("security") && (
                  <Suspense fallback={<TabSpinner />}>
                    <SecuritySettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent value="scanner" className="mt-0">
              <SettingsEditorBoundary label="Scanner">
                {mountedTabs.has("scanner") && (
                  <Suspense fallback={<TabSpinner />}>
                    <ScannerTokenGenerator />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </ErrorBoundary>
  );
}
