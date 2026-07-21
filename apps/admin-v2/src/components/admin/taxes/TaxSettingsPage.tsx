import { useSuspenseQuery } from "@tanstack/react-query";
import { Calculator, CheckCircle2, CircleOff, Layers3, MapPinned, ReceiptText, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { taxConfigurationQueryOptions } from "@/lib/api-query-options/taxes";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { usePermissions } from "@/contexts/PermissionContext";
import { TaxClassesPanel } from "./TaxClassesPanel";
import { TaxClassificationsPanel } from "./TaxClassificationsPanel";
import { TaxPreviewPanel } from "./TaxPreviewPanel";
import { TaxRatesPanel } from "./TaxRatesPanel";
import { TaxSettingsPanel } from "./TaxSettingsPanel";
import { getTaxReadiness } from "./tax-readiness";
import type { TaxClassificationRouteState } from "./tax-classification-route-state";
import type { TaxWorkspaceSection } from "./tax-workspace-sections";

const tabs = [
  { value: "policy", label: "Policy", icon: SlidersHorizontal },
  { value: "classes", label: "Classes", icon: Layers3 },
  { value: "rates", label: "Rates", icon: MapPinned },
  { value: "classification", label: "Catalog", icon: ReceiptText },
  { value: "preview", label: "Preview", icon: Calculator },
] as const;

interface TaxSettingsPageProps {
  section: TaxWorkspaceSection;
  onSectionChange: (section: TaxWorkspaceSection) => void;
  classificationRouteState: TaxClassificationRouteState;
  onClassificationRouteStateChange: (state: TaxClassificationRouteState) => void;
}

export function TaxSettingsPage({
  section,
  onSectionChange,
  classificationRouteState,
  onClassificationRouteStateChange,
}: TaxSettingsPageProps) {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
  const { data: configuration } = useSuspenseQuery(
    taxConfigurationQueryOptions(),
  );
  const readiness = getTaxReadiness(configuration);
  const activeRateCount = configuration.rates.filter((rate) => rate.isActive).length;
  const ReadinessIcon = readiness.state === "ready" ? CheckCircle2 : CircleOff;

  return (
    <div className="container max-w-7xl space-y-5 py-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Taxes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure verified classes and destination rates, then test the checkout calculation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
            <Badge variant={configuration.settings.enabled ? "default" : "secondary"}>
              {configuration.settings.enabled ? "Live calculation enabled" : "Calculation disabled"}
            </Badge>
            <Badge variant="outline">
              {configuration.classes.length} {configuration.classes.length === 1 ? "class" : "classes"}
            </Badge>
            <Badge variant="outline">
              {activeRateCount} active {activeRateCount === 1 ? "rate" : "rates"}
            </Badge>
        </div>
      </header>

      <Card>
        <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ReadinessIcon className={readiness.state === "ready" ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-muted-foreground"} aria-hidden="true" />
              <h2 className="text-sm font-semibold">{readiness.title}</h2>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{readiness.description}</p>
            <dl className="mt-3 grid gap-2 sm:grid-cols-3">
              {readiness.steps.map((step) => (
                <div key={step.id} className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
                  <dt className="flex items-center gap-1.5 text-xs font-medium">
                    {step.ready ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <CircleOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
                    {step.label}
                  </dt>
                  <dd className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{step.detail}</dd>
                </div>
              ))}
            </dl>
          </div>
          <Button type="button" className="min-h-11 md:min-h-10" variant={readiness.state === "ready" ? "outline" : "default"} onClick={() => onSectionChange(readiness.nextTab)}>
            {readiness.nextAction}
          </Button>
        </CardContent>
      </Card>

      <Tabs value={section} onValueChange={(value) => onSectionChange(value as TaxWorkspaceSection)} className="space-y-5">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg border bg-muted/40 p-1 [scrollbar-width:thin]">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} className="min-h-11 shrink-0 gap-2 rounded-md px-3 py-2.5 md:min-h-10 sm:px-4">
                <Icon className="h-4 w-4" />
                {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value="policy"><TaxSettingsPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="classes"><TaxClassesPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="rates"><TaxRatesPanel configuration={configuration} canManage={canManage} onOpenClasses={() => onSectionChange("classes")} onOpenPreview={() => onSectionChange("preview")} /></TabsContent>
        <TabsContent value="classification">
          <TaxClassificationsPanel
            configuration={configuration}
            canManage={canManage}
            routeState={classificationRouteState}
            onRouteStateChange={onClassificationRouteStateChange}
          />
        </TabsContent>
        <TabsContent value="preview"><TaxPreviewPanel configuration={configuration} /></TabsContent>
      </Tabs>
    </div>
  );
}
