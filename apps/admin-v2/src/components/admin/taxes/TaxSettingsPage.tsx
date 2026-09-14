import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Calculator, Layers3, MapPinned, ReceiptText, SlidersHorizontal } from "lucide-react";

import { EditorSheet } from "~/components/admin/shell/EditorSheet";
import { PageHeader, type PageHeaderAction } from "~/components/admin/shell/PageHeader";
import { PageTabs, type PageTabItem } from "~/components/admin/shell/PageTabs";
import { SkeletonPage } from "~/components/admin/shell/SkeletonPage";
import { StatusBadge, type StatusTone } from "~/components/admin/shell/StatusBadge";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { TaxClassRecord, TaxRateRecord } from "~/lib/api-functions/taxes";
import { taxConfigurationQueryOptions } from "~/lib/api-query-options/taxes";
import { TaxClassesPanel } from "./TaxClassesPanel";
import { TaxClassFormSheet } from "./TaxClassFormSheet";
import { TaxClassificationsPanel } from "./TaxClassificationsPanel";
import { TaxPreviewPanel } from "./TaxPreviewPanel";
import { TaxRateFormSheet } from "./TaxRateFormSheet";
import { TaxRatesPanel } from "./TaxRatesPanel";
import { TaxSettingsPanel } from "./TaxSettingsPanel";
import { getTaxReadiness, type TaxReadiness } from "./tax-readiness";
import type { TaxClassificationRouteState } from "./tax-classification-route-state";
import {
  resolveTaxWorkspaceTarget,
  type TaxWorkspaceRouteSection,
  type TaxWorkspaceSection,
} from "./tax-workspace-sections";

const TAX_WORKSPACE_PANEL_ID = "tax-workspace-panel";

const tabs: readonly (PageTabItem & { value: TaxWorkspaceSection })[] = [
  { value: "rates", label: "Rates", icon: MapPinned },
  { value: "classes", label: "Classes", icon: Layers3 },
  { value: "settings", label: "Settings", icon: SlidersHorizontal },
  { value: "classification", label: "Classification", icon: ReceiptText },
];

/** Readiness state maps onto one badge tone; the label always carries the meaning. */
export const READINESS_TONES: Record<TaxReadiness["state"], StatusTone> = {
  ready: "success",
  attention: "attention",
  off: "neutral",
};

interface TaxSettingsPageProps {
  section: TaxWorkspaceSection;
  onSectionChange: (section: TaxWorkspaceSection) => void;
  previewOpen: boolean;
  onPreviewOpenChange: (open: boolean) => void;
  classificationRouteState: TaxClassificationRouteState;
  onClassificationRouteStateChange: (state: TaxClassificationRouteState) => void;
}

/** Loading shape shown while the tax configuration resolves. */
export function TaxSettingsPageSkeleton() {
  return (
    <div className="container max-w-7xl py-6">
      <SkeletonPage sections={2} rowsPerSection={4} label="Loading taxes" />
    </div>
  );
}

export function TaxSettingsPage({
  section,
  onSectionChange,
  previewOpen,
  onPreviewOpenChange,
  classificationRouteState,
  onClassificationRouteStateChange,
}: TaxSettingsPageProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
  const { data: configuration } = useSuspenseQuery(taxConfigurationQueryOptions());
  const readiness = getTaxReadiness(configuration);

  const [rateEditor, setRateEditor] = useState<{
    open: boolean;
    editing: TaxRateRecord | null;
    initialTaxClassId?: string;
  }>({ open: false, editing: null });
  const [classEditor, setClassEditor] = useState<{
    open: boolean;
    editing: TaxClassRecord | null;
  }>({ open: false, editing: null });

  /** Sends a readiness target (a deep-link value) to the tab or sheet that owns it. */
  function openTarget(target: TaxWorkspaceRouteSection) {
    const resolved = resolveTaxWorkspaceTarget(target);
    if (resolved.preview) {
      onPreviewOpenChange(true);
      return;
    }
    onSectionChange(resolved.section);
  }

  function openRateEditor(rate: TaxRateRecord | null, initialTaxClassId?: string) {
    setRateEditor({ open: true, editing: rate, initialTaxClassId });
  }

  const activeTab = tabs.find((tab) => tab.value === section) ?? tabs[0];
  const readinessTarget = resolveTaxWorkspaceTarget(readiness.nextTab);
  const activeRateCount = configuration.rates.filter((rate) => rate.isActive).length;

  const primaryAction: PageHeaderAction | undefined = section === "rates"
    ? {
        id: "add-rate",
        label: "Add tax rate",
        onClick: () => openRateEditor(null),
        disabled: !canManage || configuration.classes.length === 0,
        disabledReason: configuration.classes.length === 0
          ? "Add a tax class before adding a rate."
          : "You do not have permission to manage taxes.",
      }
    : section === "classes"
      ? {
          id: "add-class",
          label: "Add tax class",
          onClick: () => setClassEditor({ open: true, editing: null }),
          disabled: !canManage,
          disabledReason: "You do not have permission to manage taxes.",
        }
      : undefined;

  const secondaryActions: PageHeaderAction[] = [
    {
      id: "preview",
      label: "Preview calculation",
      icon: Calculator,
      onClick: () => onPreviewOpenChange(true),
    },
  ];
  // Readiness that points at the preview is already covered by the button above.
  if (!readinessTarget.preview && readinessTarget.section !== section) {
    secondaryActions.push({
      id: "readiness-next",
      label: readiness.nextAction,
      onClick: () => openTarget(readiness.nextTab),
    });
  }

  return (
    <div className="container max-w-7xl py-6">
      <PageHeader
        title="Taxes"
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        status={(
          <>
            <StatusBadge tone={READINESS_TONES[readiness.state]} srLabel="Tax status:">
              {readiness.title}
            </StatusBadge>
            <span>{readiness.description}</span>
          </>
        )}
      />

      <div className="space-y-6">
        <PageTabs
          tabs={tabs}
          value={section}
          onChange={(value) => onSectionChange(value as TaxWorkspaceSection)}
          label="Tax workspace section"
          panelId={TAX_WORKSPACE_PANEL_ID}
        />

        <div
          id={TAX_WORKSPACE_PANEL_ID}
          role="tabpanel"
          aria-label={activeTab.label}
        >
          {section === "rates" ? (
            <TaxRatesPanel
              configuration={configuration}
              canManage={canManage}
              onCreateRate={(taxClassId) => openRateEditor(null, taxClassId)}
              onEditRate={(rate) => openRateEditor(rate)}
              onOpenClasses={() => onSectionChange("classes")}
              onOpenPreview={() => onPreviewOpenChange(true)}
            />
          ) : null}
          {section === "classes" ? (
            <TaxClassesPanel
              configuration={configuration}
              canManage={canManage}
              onCreateClass={() => setClassEditor({ open: true, editing: null })}
              onEditClass={(taxClass) => setClassEditor({ open: true, editing: taxClass })}
            />
          ) : null}
          {section === "settings" ? (
            <TaxSettingsPanel
              configuration={configuration}
              canManage={canManage}
              onOpenTarget={openTarget}
            />
          ) : null}
          {section === "classification" ? (
            <TaxClassificationsPanel
              configuration={configuration}
              canManage={canManage}
              routeState={classificationRouteState}
              onRouteStateChange={onClassificationRouteStateChange}
            />
          ) : null}
        </div>
      </div>

      <TaxRateFormSheet
        open={rateEditor.open}
        onOpenChange={(open) => setRateEditor((current) => ({ ...current, open }))}
        configuration={configuration}
        canManage={canManage}
        editing={rateEditor.editing}
        initialTaxClassId={rateEditor.initialTaxClassId}
      />
      <TaxClassFormSheet
        open={classEditor.open}
        onOpenChange={(open) => setClassEditor((current) => ({ ...current, open }))}
        canManage={canManage}
        editing={classEditor.editing}
      />

      <EditorSheet
        open={previewOpen}
        onOpenChange={onPreviewOpenChange}
        width="md"
        title="Preview calculation"
        description={(
          <>
            {configuration.classes.length} {configuration.classes.length === 1 ? "class" : "classes"}
            {" and "}
            {activeRateCount} active {activeRateCount === 1 ? "rate" : "rates"} are saved.
          </>
        )}
      >
        <TaxPreviewPanel configuration={configuration} />
      </EditorSheet>
    </div>
  );
}
