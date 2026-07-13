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
    <div className="space-y-6">
      <Tabs
        value={section}
        onValueChange={(value) =>
          onSectionChange(value as MetaConversionsWorkspaceSection)
        }
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="logs" className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-6">
          <MetaConversionsSettingsForm
            initialSettings={initialSettings}
            initialPixelParity={initialPixelParity}
            retentionInfo={null}
          />
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
          <MetaConversionsLogs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
