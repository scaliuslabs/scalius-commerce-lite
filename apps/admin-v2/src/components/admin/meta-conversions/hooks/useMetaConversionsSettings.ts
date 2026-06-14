import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { MetaConversionsSettings, FormData } from "../MetaConversionsSettingsForm";
import {
  getMetaConversionsSettings,
  type SettingsPayload,
  updateMetaConversionsSettings,
} from "~/lib/api-functions/settings";
import { getServerFnError } from "@/lib/api-helpers";

const DEFAULT_FORM_DATA: FormData = {
  pixelId: "",
  accessToken: "",
  testEventCode: "",
  isEnabled: false,
  logRetentionDays: 30,
};

export function useMetaConversionsSettings(initialSettings?: MetaConversionsSettings) {
  const [settings, setSettings] = useState<MetaConversionsSettings | null>(
    initialSettings || null,
  );
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  useEffect(() => {
    const currentValues = settings || DEFAULT_FORM_DATA;
    const hasChanges = Object.keys(formData).some(
      (key) =>
        formData[key as keyof FormData] !==
        (currentValues[key as keyof FormData] ||
          DEFAULT_FORM_DATA[key as keyof FormData]),
    );
    setHasUnsavedChanges(hasChanges);
  }, [formData, settings]);

  const fetchSettings = useCallback(async () => {
    setIsSettingsLoading(true);
    try {
      const data = await getMetaConversionsSettings() as Record<string, unknown>;
      const s = data.settings as MetaConversionsSettings | null;
      setSettings(s);
      setFormData(
        s
          ? {
            pixelId: s.pixelId || "",
            accessToken: s.accessToken || "",
            testEventCode: s.testEventCode || "",
            isEnabled: s.isEnabled || false,
            logRetentionDays: s.logRetentionDays || 30,
          }
          : DEFAULT_FORM_DATA,
      );
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialSettings) {
      setFormData({
        pixelId: initialSettings.pixelId || "",
        accessToken: initialSettings.accessToken || "",
        testEventCode: initialSettings.testEventCode || "",
        isEnabled: initialSettings.isEnabled || false,
        logRetentionDays: initialSettings.logRetentionDays || 30,
      });
    } else {
      void fetchSettings();
    }
  }, [fetchSettings, initialSettings]);

  const handleSaveSettings = async () => {
    setIsSettingsLoading(true);
    try {
      const data = await updateMetaConversionsSettings({ data: formData as unknown as SettingsPayload });
      setSettings(data as unknown as MetaConversionsSettings);
      setHasUnsavedChanges(false);
      toast.success("Settings saved successfully");
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to save settings"));
    } finally {
      setIsSettingsLoading(false);
    }
  };

  const handleResetForm = () => {
    if (settings) {
      setFormData({
        pixelId: settings.pixelId || "",
        accessToken: settings.accessToken || "",
        testEventCode: settings.testEventCode || "",
        isEnabled: settings.isEnabled || false,
        logRetentionDays: settings.logRetentionDays || 30,
      });
    }
  };

  const updateFormData = (
    field: keyof FormData,
    value: string | number | boolean,
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return {
    formData,
    isSettingsLoading,
    showAccessToken,
    setShowAccessToken,
    hasUnsavedChanges,
    handleSaveSettings,
    handleResetForm,
    updateFormData,
  };
}
