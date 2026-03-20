import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { MetaConversionsSettings, FormData } from "../MetaConversionsSettingsForm";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

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
    if (initialSettings) {
      setFormData({
        pixelId: initialSettings.pixelId || "",
        accessToken: initialSettings.accessToken || "",
        testEventCode: initialSettings.testEventCode || "",
        isEnabled: initialSettings.isEnabled || false,
        logRetentionDays: initialSettings.logRetentionDays || 30,
      });
    } else {
      fetchSettings();
    }
  }, [initialSettings]);

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
      const response = await fetch("/api/v1/admin/settings/meta-conversions");
      if (response.ok) {
        const json = await response.json();
        const data = unwrapEnvelope(json);
        setSettings(data.settings);
        setFormData(
          data.settings
            ? {
              pixelId: data.settings.pixelId || "",
              accessToken: data.settings.accessToken || "",
              testEventCode: data.settings.testEventCode || "",
              isEnabled: data.settings.isEnabled || false,
              logRetentionDays: data.settings.logRetentionDays || 30,
            }
            : DEFAULT_FORM_DATA,
        );
      }
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  const handleSaveSettings = async () => {
    setIsSettingsLoading(true);
    try {
      const response = await fetch("/api/v1/admin/settings/meta-conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(extractApiError(errorData, "Failed to save settings"));
      }

      const json = await response.json();
      const data = unwrapEnvelope(json);
      setSettings(data);
      setHasUnsavedChanges(false);
      toast.success("Settings saved successfully");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to save settings";
      toast.error(msg);
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
