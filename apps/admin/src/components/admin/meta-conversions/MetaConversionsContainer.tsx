import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Settings, Activity } from "lucide-react";
import { MetaConversionsSettingsForm, type MetaConversionsSettings } from "./MetaConversionsSettingsForm";
import { MetaConversionsLogs } from "./MetaConversionsLogs";

interface MetaConversionsContainerProps {
  initialSettings?: MetaConversionsSettings;
}

export function MetaConversionsContainer({
  initialSettings,
}: MetaConversionsContainerProps) {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="settings" className="w-full">
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
