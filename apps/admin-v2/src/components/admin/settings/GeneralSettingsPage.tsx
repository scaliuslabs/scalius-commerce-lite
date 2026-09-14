import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { ErrorBoundary } from "../ErrorBoundary";
import { PageHeader } from "../shell";
import type {
  HeaderBuilderPanel,
  HeaderConfig,
} from "../header-builder/types";
import type {
  FooterBuilderPanel,
  FooterConfig,
} from "../footer-builder/types";
import {
  DEFAULT_GENERAL_SETTINGS_SECTION,
  GENERAL_SETTINGS_SECTIONS,
  type GeneralSettingsPanel,
  type GeneralSettingsSection,
} from "./general-settings-sections";
import { SettingsNav, type SettingsNavLinkProps } from "./SettingsNav";
import {
  findSettingsNavSection,
  getVisibleSettingsNavGroups,
  SETTINGS_INDEX_PATH,
} from "./settings-navigation";
import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";
import { PanelLoadingSkeleton } from "../shared/LoadingFallback";

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
const PlatformSettingsBuilder = lazy(() =>
  import("./PlatformSettingsBuilder").then((m) => ({
    default: m.PlatformSettingsBuilder,
  })),
);

function SectionLoading() {
  return <PanelLoadingSkeleton />;
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
  /** Permissions the operator holds; controls which destinations are listed. */
  permissions?: Set<string>;
  isSuperAdmin?: boolean;
  /** Router-aware link for the standalone settings routes. */
  linkComponent?: ComponentType<SettingsNavLinkProps>;
}

/** The boundary label shown when a single editor fails to open. */
const SECTION_BOUNDARY_LABELS: Record<GeneralSettingsSection, string> = {
  header: "Header",
  footer: "Footer",
  seo: "SEO",
  storefront: "Storefront",
  email: "Email",
  currency: "Currency",
  media: "Media",
  business: "Business",
  countries: "Countries",
  auth: "Auth & Access",
  security: "Security",
  scanner: "Scanner",
  platform: "Platform",
};

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
  permissions,
  isSuperAdmin = false,
  linkComponent,
}: GeneralSettingsPageProps) {
  // Editors stay mounted once visited so a half-finished draft survives a trip
  // to another section; only the visited ones pay for their chunk.
  const [mountedSections, setMountedSections] = useState<Set<string>>(
    () => new Set([section]),
  );
  // Below `lg` the settings area is a list page plus one section page, the way
  // a phone expects. A `?section=` deep link opens that section directly; a
  // bare `/admin/settings` opens the list.
  const [mobileView, setMobileView] = useState<"index" | "section">(() =>
    section === DEFAULT_GENERAL_SETTINGS_SECTION ? "index" : "section",
  );

  useEffect(() => {
    setMountedSections((prev) => {
      if (prev.has(section)) return prev;
      const next = new Set(prev);
      next.add(section);
      return next;
    });
  }, [section]);

  const rememberWorkspaceScroll = useWorkspaceScrollMemory(
    `${section}:${panel ?? ""}`,
  );

  const groups = useMemo(
    () => getVisibleSettingsNavGroups(permissions, isSuperAdmin),
    [permissions, isSuperAdmin],
  );
  const current = findSettingsNavSection(section);

  const handleSelectSection = useCallback(
    (item: { section: GeneralSettingsSection }) => {
      setMobileView("section");
      onSectionChange(item.section);
    },
    [onSectionChange],
  );

  const headerPanel = section === "header"
    ? (panel as HeaderBuilderPanel | undefined)
    : undefined;
  const footerPanel = section === "footer"
    ? (panel as FooterBuilderPanel | undefined)
    : undefined;

  const sectionContent: Record<GeneralSettingsSection, ReactNode> = {
    header: (
      <HeaderBuilder
        activePanel={headerPanel}
        initialConfig={headerConfig}
        initialRevision={headerRevision}
        readiness={headerReadiness}
        onPanelChange={onPanelChange}
      />
    ),
    footer: (
      <FooterBuilder
        activePanel={footerPanel}
        initialConfig={footerConfig}
        initialRevision={footerRevision}
        readiness={footerReadiness}
        onPanelChange={onPanelChange}
      />
    ),
    seo: <SeoSettingsBuilder />,
    storefront: <StorefrontUrlBuilder />,
    email: <EmailSettingsForm />,
    currency: <CurrencySettingsBuilder />,
    media: <MediaSettingsBuilder />,
    business: <BusinessSettingsBuilder />,
    countries: <AllowedCountriesBuilder />,
    auth: <AuthSettingsBuilder />,
    security: <SecuritySettingsBuilder />,
    scanner: <ScannerTokenGenerator />,
    platform: <PlatformSettingsBuilder />,
  };

  const showIndexOnMobile = mobileView === "index";

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
        <div className="grid min-w-0 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div
            className={cn("min-w-0", !showIndexOnMobile && "hidden lg:block")}
          >
            <p className="mb-2 hidden text-xl font-semibold tracking-tight lg:block">
              Settings
            </p>
            <SettingsNav
              groups={groups}
              location={{ pathname: SETTINGS_INDEX_PATH, section }}
              onSelectSection={handleSelectSection}
              linkComponent={linkComponent}
              variant="sidebar"
              className="hidden lg:sticky lg:top-16 lg:block lg:self-start"
            />

            {showIndexOnMobile ? (
              <div className="lg:hidden">
                <PageHeader
                  title="Settings"
                  subtitle="Everything that changes how this store works."
                  className="mb-3"
                />
                <SettingsNav
                  groups={groups}
                  location={{ pathname: SETTINGS_INDEX_PATH, section }}
                  onSelectSection={handleSelectSection}
                  linkComponent={linkComponent}
                  variant="index"
                />
              </div>
            ) : null}
          </div>

          <div className={showIndexOnMobile ? "hidden min-w-0 lg:block" : "min-w-0"}>
            {showIndexOnMobile ? null : (
              <button
                type="button"
                className="mb-2 -ml-1 inline-flex min-h-11 items-center gap-1 rounded-sm px-1 text-sm font-medium text-muted-foreground hover:text-foreground lg:hidden"
                onClick={() => setMobileView("index")}
              >
                <ChevronLeft className="size-4" aria-hidden />
                All settings
              </button>
            )}

            <PageHeader
              title={current?.label ?? "Settings"}
              subtitle={current?.description}
              className="mb-4"
            />

            {GENERAL_SETTINGS_SECTIONS.map((value) => {
              const active = value === section;
              if (!mountedSections.has(value) && !active) return null;
              return (
                <div
                  key={value}
                  data-settings-panel={value}
                  data-state={active ? "active" : "inactive"}
                  hidden={!active}
                  className="min-w-0 data-[state=inactive]:hidden"
                >
                  <SettingsEditorBoundary label={SECTION_BOUNDARY_LABELS[value]}>
                    <Suspense fallback={<SectionLoading />}>
                      {sectionContent[value]}
                    </Suspense>
                  </SettingsEditorBoundary>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
