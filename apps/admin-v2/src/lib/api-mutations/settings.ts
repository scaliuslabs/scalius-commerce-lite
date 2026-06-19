import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  saveFooterConfig,
  saveHeaderConfig,
  type FooterConfigInput,
  type HeaderConfigInput,
  type SettingsPayload,
  updateAuthSettings,
  updateBusinessSettings,
  updateEmailSettings,
  updateFirebaseSettings,
  updateMediaSettings,
  updateSecuritySettings,
  updateSeoSettings,
  updateSettingsByCategory,
  updateSmsSettings,
  updateStorefrontUrl,
  updateThemeSettings,
} from "../api-functions/settings";
import { updateCurrencySettings } from "../api-functions/currency";
import { getServerFnError, queryKeys } from "./shared";

export function useUpdateSettings(category: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SettingsPayload) =>
      updateSettingsByCategory({ data: { category, settings } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.byCategory(category),
      });
      toast.success("Settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update settings")),
  });
}

export function useSaveHeaderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: HeaderConfigInput) => saveHeaderConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      toast.success("Header config saved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to save header config")),
  });
}

export function useSaveFooterConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: FooterConfigInput) => saveFooterConfig({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.general() });
      toast.success("Footer config saved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to save footer config")),
  });
}

export function useUpdateStorefrontUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storefrontUrl: string) =>
      updateStorefrontUrl({ data: { storefrontUrl } }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.storefrontUrl(),
      });
      toast.success("Storefront URL updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update storefront URL")),
  });
}

export function useUpdateCurrencySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateCurrencySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.currency(),
      });
      toast.success("Currency settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update currency settings")),
  });
}

export function useUpdateSeoSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateSeoSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.seo() });
      toast.success("SEO settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update SEO settings")),
  });
}

export function useUpdateSecuritySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateSecuritySettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.security(),
      });
      toast.success("Security settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update security settings")),
  });
}

export function useUpdateAuthSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateAuthSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.auth() });
      toast.success("Auth settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update auth settings")),
  });
}

export function useUpdateEmailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateEmailSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.email() });
      toast.success("Email settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update email settings")),
  });
}

export function useUpdateFirebaseSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateFirebaseSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.firebase(),
      });
      toast.success("Firebase settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update Firebase settings")),
  });
}

export function useUpdateBusinessSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateBusinessSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.settings.business(),
      });
      toast.success("Business settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update business settings")),
  });
}

export function useUpdateThemeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateThemeSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.theme() });
      toast.success("Theme settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update theme settings")),
  });
}

export function useUpdateMediaSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateMediaSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.media() });
      toast.success("Media settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update media settings")),
  });
}

export function useUpdateSmsSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: SettingsPayload) => updateSmsSettings({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.sms() });
      toast.success("SMS settings updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update SMS settings")),
  });
}
