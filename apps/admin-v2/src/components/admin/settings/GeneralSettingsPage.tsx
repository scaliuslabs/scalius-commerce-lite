import { useEffect, useState, lazy, Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
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
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";

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
  { value: "header", label: "Header", group: "Storefront" },
  { value: "footer", label: "Footer", group: "Storefront" },
  { value: "seo", label: "SEO", group: "Storefront" },
  { value: "storefront", label: "Storefront URL", group: "Storefront" },
  { value: "media", label: "Media delivery", group: "Storefront" },
  { value: "business", label: "Business details", group: "Operations" },
  { value: "currency", label: "Currency", group: "Operations" },
  { value: "countries", label: "Customer countries", group: "Operations" },
  { value: "email", label: "Email delivery", group: "Operations" },
  { value: "auth", label: "Customer sign-in", group: "Access & security" },
  { value: "security", label: "Security", group: "Access & security" },
  { value: "scanner", label: "Warehouse scanner", group: "Access & security" },
] as const;

const tabGroups = ["Storefront", "Operations", "Access & security"] as const;

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

  const rememberWorkspaceScroll = useWorkspaceScrollMemory(
    `${section}:${panel ?? ""}`,
  );
  const handleTabChange = (value: string) => {
    onSectionChange(value as GeneralSettingsSection);
  };
  const handlePanelChange = (nextPanel: GeneralSettingsPanel) => {
    onPanelChange(nextPanel);
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
      <div
        className="mx-auto max-w-6xl"
        onPointerDownCapture={rememberWorkspaceScroll}
        onKeyDownCapture={rememberWorkspaceScroll}
      >
        <div className="mb-4">
          <h1 className="text-xl font-semibold tracking-tight">
            General settings
          </h1>
        </div>

        <div className="sticky top-0 z-20 -mx-3 mb-4 bg-gray-50 px-3 py-2 dark:bg-[#0a0a0a] sm:-mx-4 sm:px-4 md:-mx-6 md:px-6 lg:hidden">
          <Select value={section} onValueChange={handleTabChange}>
            <SelectTrigger aria-label="Settings section" className="h-11 w-full bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tabGroups.map((group, groupIndex) => (
                <SelectGroup key={group}>
                  {groupIndex > 0 ? <SelectSeparator /> : null}
                  <SelectLabel className="text-xs text-muted-foreground">
                    {group}
                  </SelectLabel>
                  {tabs.filter((tab) => tab.group === group).map((tab) => (
                    <SelectItem key={tab.value} value={tab.value} className="min-h-11">
                      {tab.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs
          value={section}
          onValueChange={handleTabChange}
          className="grid min-w-0 gap-4 lg:grid-cols-[12rem_minmax(0,1fr)]"
        >
          <TabsList className="hidden h-auto min-w-0 justify-start gap-0 rounded-md border border-border bg-card p-1 lg:sticky lg:top-16 lg:flex lg:flex-col lg:self-start">
            {tabGroups.map((group) => (
              <div key={group} role="presentation" className="w-full py-1 first:pt-0 last:pb-0">
                <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-1">
                  {group}
                </p>
                {tabs.filter((tab) => tab.group === group).map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="h-10 w-full justify-start rounded-sm px-2.5 text-sm font-medium text-muted-foreground transition-none hover:bg-muted/60 hover:text-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </div>
            ))}
          </TabsList>

          <div className="min-w-0">
            <TabsContent forceMount value="header" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Header">
                {(mountedTabs.has("header") || section === "header") && (
                  <Suspense fallback={<TabSpinner />}>
                    <HeaderBuilder
                      activePanel={headerPanel}
                      initialConfig={headerConfig}
                      initialRevision={headerRevision}
                      readiness={headerReadiness}
                      onPanelChange={handlePanelChange}
                    />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="footer" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Footer">
                {(mountedTabs.has("footer") || section === "footer") && (
                  <Suspense fallback={<TabSpinner />}>
                    <FooterBuilder
                      activePanel={footerPanel}
                      initialConfig={footerConfig}
                      initialRevision={footerRevision}
                      readiness={footerReadiness}
                      onPanelChange={handlePanelChange}
                    />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="seo" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="SEO">
                {(mountedTabs.has("seo") || section === "seo") && (
                  <Suspense fallback={<TabSpinner />}>
                    <SeoSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="storefront" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Storefront">
                {(mountedTabs.has("storefront") || section === "storefront") && (
                  <Suspense fallback={<TabSpinner />}>
                    <StorefrontUrlBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="email" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Email">
                {(mountedTabs.has("email") || section === "email") && (
                  <Suspense fallback={<TabSpinner />}>
                    <EmailSettingsForm />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="currency" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Currency">
                {(mountedTabs.has("currency") || section === "currency") && (
                  <Suspense fallback={<TabSpinner />}>
                    <CurrencySettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="media" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Media">
                {(mountedTabs.has("media") || section === "media") && (
                  <Suspense fallback={<TabSpinner />}>
                    <MediaSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="business" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Business">
                {(mountedTabs.has("business") || section === "business") && (
                  <Suspense fallback={<TabSpinner />}>
                    <BusinessSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="countries" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Countries">
                {(mountedTabs.has("countries") || section === "countries") && (
                  <Suspense fallback={<TabSpinner />}>
                    <AllowedCountriesBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="auth" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Auth & Access">
                {(mountedTabs.has("auth") || section === "auth") && (
                  <Suspense fallback={<TabSpinner />}>
                    <AuthSettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="security" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Security">
                {(mountedTabs.has("security") || section === "security") && (
                  <Suspense fallback={<TabSpinner />}>
                    <SecuritySettingsBuilder />
                  </Suspense>
                )}
              </SettingsEditorBoundary>
            </TabsContent>

            <TabsContent forceMount value="scanner" className="mt-0 data-[state=inactive]:hidden">
              <SettingsEditorBoundary label="Scanner">
                {(mountedTabs.has("scanner") || section === "scanner") && (
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
