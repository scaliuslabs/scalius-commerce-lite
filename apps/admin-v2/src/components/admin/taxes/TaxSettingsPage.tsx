import { useSuspenseQuery } from "@tanstack/react-query";
import { Calculator, Layers3, MapPinned, ReceiptText, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { taxConfigurationQueryOptions } from "@/lib/api-query-options/taxes";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { usePermissions } from "@/contexts/PermissionContext";
import { TaxClassesPanel } from "./TaxClassesPanel";
import { TaxClassificationsPanel } from "./TaxClassificationsPanel";
import { TaxPreviewPanel } from "./TaxPreviewPanel";
import { TaxRatesPanel } from "./TaxRatesPanel";
import { TaxSettingsPanel } from "./TaxSettingsPanel";

const tabs = [
  { value: "policy", label: "Policy", icon: SlidersHorizontal },
  { value: "classes", label: "Classes", icon: Layers3 },
  { value: "rates", label: "Rates", icon: MapPinned },
  { value: "classification", label: "Catalog", icon: ReceiptText },
  { value: "preview", label: "Preview", icon: Calculator },
] as const;

export function TaxSettingsPage() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.TAXES_MANAGE);
  const { data: configuration } = useSuspenseQuery(
    taxConfigurationQueryOptions(),
  );

  return (
    <div className="container max-w-7xl space-y-7 py-8">
      <header className="relative overflow-hidden rounded-2xl border bg-card px-6 py-7 shadow-sm">
        <div className="absolute inset-y-0 right-0 w-1/3 bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.12),transparent_70%)]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              <ReceiptText className="h-4 w-4" />
              Checkout authority
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">Taxes</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Configure merchant-verified classes and destination rates, classify products and SKUs, and preview the exact minor-unit engine used by checkout.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={configuration.settings.enabled ? "default" : "secondary"}>
              {configuration.settings.enabled ? "Live calculation enabled" : "Calculation disabled"}
            </Badge>
            <Badge variant="outline">{configuration.classes.length} classes</Badge>
            <Badge variant="outline">{configuration.rates.filter((rate) => rate.isActive).length} active rates</Badge>
          </div>
        </div>
      </header>

      <Tabs defaultValue="policy" className="space-y-6">
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border bg-muted/40 p-1.5">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-2 rounded-lg px-4 py-2.5">
                <Icon className="h-4 w-4" />
                {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value="policy"><TaxSettingsPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="classes"><TaxClassesPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="rates"><TaxRatesPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="classification"><TaxClassificationsPanel configuration={configuration} canManage={canManage} /></TabsContent>
        <TabsContent value="preview"><TaxPreviewPanel configuration={configuration} /></TabsContent>
      </Tabs>
    </div>
  );
}
