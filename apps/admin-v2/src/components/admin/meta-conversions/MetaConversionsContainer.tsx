import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, Activity } from "lucide-react";
import {
  MetaConversionsSettingsForm,
  type MetaConversionsSettings,
} from "./MetaConversionsSettingsForm";
import type { MetaPixelParityDiagnostics } from "~/types/api-responses";
import { MetaConversionsLogs } from "./MetaConversionsLogs";
import type { MetaConversionsWorkspaceSection } from "./meta-conversions-workspace";

interface MetaConversionsContainerProps {
  initialSettings?: MetaConversionsSettings;
  initialPixelParity?: MetaPixelParityDiagnostics | null;
  section: MetaConversionsWorkspaceSection;
  onSectionChange: (section: MetaConversionsWorkspaceSection) => void;
}

export function MetaConversionsContainer({
  initialSettings,
  initialPixelParity,
  section,
  onSectionChange,
}: MetaConversionsContainerProps) {
  return (
    <div className="space-y-4">
      <Tabs
        value={section}
        onValueChange={(value) =>
          onSectionChange(value as MetaConversionsWorkspaceSection)
        }
        className="w-full"
      >
        <TabsList className="grid min-h-11 w-full grid-cols-2 sm:min-h-9">
          <TabsTrigger value="settings" className="min-h-11 gap-2 sm:min-h-8">
            <Settings className="w-4 h-4" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="logs" className="min-h-11 gap-2 sm:min-h-8">
            <Activity className="w-4 h-4" />
            Delivery activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-6">
          <MetaConversionsSettingsForm
            initialSettings={initialSettings}
            initialPixelParity={initialPixelParity}
          />
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
          <MetaConversionsLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
