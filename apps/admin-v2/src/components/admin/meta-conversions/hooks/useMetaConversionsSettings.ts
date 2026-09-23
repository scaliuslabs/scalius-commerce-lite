import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import type { FormData } from "../MetaConversionsSettingsForm";
import type {
  MetaConversionsSettings,
  MetaConversionsSettingsResponse,
  MetaPixelParityDiagnostics,
} from "~/lib/api-query-options/settings";
import { getServerFnError } from "@/lib/api-helpers";
import {
  getMetaConversionsEnableIssue,
  getMetaConversionsSettingsIssue,
} from "./readiness";
import {
  getApiV1AdminSettingsMetaConversions,
  postApiV1AdminSettingsMetaConversions,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";

const DEFAULT_FORM_DATA: FormData = {
  pixelId: "",
  accessToken: "",
  testEventCode: "",
  isEnabled: false,
  logRetentionDays: 30,
};

function formDataFromSettings(settings: MetaConversionsSettings | null): FormData {
  const formData = settings
    ? {
      pixelId: settings.pixelId || "",
      accessToken: settings.accessToken || "",
      testEventCode: settings.testEventCode || "",
      isEnabled: settings.isEnabled || false,
      logRetentionDays: settings.logRetentionDays || 30,
    }
    : DEFAULT_FORM_DATA;

  if (formData.isEnabled && getMetaConversionsEnableIssue(formData)) {
    return { ...formData, isEnabled: false };
  }

  return formData;
}

export function useMetaConversionsSettings(
  initialSettings?: MetaConversionsSettings,
  initialPixelParity?: MetaPixelParityDiagnostics | null,
) {
  const [settings, setSettings] = useState<MetaConversionsSettings | null>(
    initialSettings || null,
  );
  const [pixelParity, setPixelParity] =
    useState<MetaPixelParityDiagnostics | null>(initialPixelParity ?? null);
  const [formData, setFormData] = useState<FormData>(() =>
    formDataFromSettings(initialSettings ?? null),
  );
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const settingsIssue = getMetaConversionsSettingsIssue(formData);
  const enableIssue = getMetaConversionsEnableIssue(formData);

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

  const applySettingsResponse = useCallback((data: MetaConversionsSettingsResponse) => {
    const s = data.settings ?? null;
    setSettings(s);
    setPixelParity(data.pixelParity ?? null);
    setFormData(formDataFromSettings(s));
  }, []);

  const fetchSettings = useCallback(async () => {
    setIsSettingsLoading(true);
    try {
      const data = await apiData(getApiV1AdminSettingsMetaConversions());
      applySettingsResponse(data);
    } catch {
      toast.error("Failed to load settings");
    } finally {
      setIsSettingsLoading(false);
    }
  }, [applySettingsResponse]);

  useEffect(() => {
    if (initialSettings || initialPixelParity) {
      applySettingsResponse({
        settings: initialSettings ?? null,
        pixelParity: initialPixelParity ?? {
          status: "not_configured",
          severity: "neutral",
          message:
            "Save a Meta Pixel ID to compare server-side CAPI with the active browser Pixel.",
          capiPixelId: null,
          activeBrowserPixelIds: [],
          activeFacebookPixelScriptCount: 0,
          parseableFacebookPixelScriptCount: 0,
        },
      });
    } else {
      void fetchSettings();
    }
  }, [applySettingsResponse, fetchSettings, initialPixelParity, initialSettings]);

  const handleSaveSettings = async () => {
    const issue = getMetaConversionsSettingsIssue(formData);
    if (issue) {
      toast.error(issue);
      return;
    }

    setIsSettingsLoading(true);
    try {
      const savedSettings = await apiData(postApiV1AdminSettingsMetaConversions({ body: formData }));
      setSettings(savedSettings);
      setFormData(formDataFromSettings(savedSettings));
      setHasUnsavedChanges(false);
      try {
        const refreshed = await apiData(getApiV1AdminSettingsMetaConversions());
        applySettingsResponse(refreshed);
      } catch {
        toast.warning("Settings saved, but the Pixel match check could not refresh.");
      }
      toast.success("Settings saved successfully");
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to save settings"));
    } finally {
      setIsSettingsLoading(false);
    }
  };

  const handleResetForm = () => {
    setFormData(formDataFromSettings(settings));
  };

  const updateFormData = (
    field: keyof FormData,
    value: string | number | boolean,
  ) => {
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (next.isEnabled && getMetaConversionsEnableIssue(next)) {
        return { ...next, isEnabled: false };
      }
      return next;
    });
  };

  return {
    formData,
    isSettingsLoading,
    showAccessToken,
    setShowAccessToken,
    hasUnsavedChanges,
    settingsIssue,
    enableIssue,
    pixelParity,
    handleSaveSettings,
    handleResetForm,
    updateFormData,
  };
}
