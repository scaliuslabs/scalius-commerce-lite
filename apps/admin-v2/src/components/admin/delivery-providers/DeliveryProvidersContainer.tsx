import { type FC, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  type DeliveryProviderRecord,
  type DeliveryProviderType,
} from "./ProviderIcon";
import { ProviderListSidebar } from "./ProviderListSidebar";
import { ProviderDetailPanel } from "./ProviderDetailPanel";
import { getServerFnError } from "~/lib/api-helpers";
import {
  saveDeliveryProvider,
  deleteDeliveryProvider,
  testDeliveryProvider,
  testDeliveryCredentials,
} from "~/lib/api-functions/delivery";
import { queryKeys } from "~/lib/query-keys";

// Default credentials structure per provider type
const DEFAULT_CREDENTIALS = {
  pathao: {
    baseUrl: "https://api-hermes.pathao.com",
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    webhookSecret: "",
  },
  steadfast: {
    baseUrl: "https://portal.steadfast.com.bd/api/v1",
    apiKey: "",
    secretKey: "",
    webhookSecret: "",
  },
};

const DEFAULT_CONFIG = {
  pathao: {
    storeId: "",
    defaultDeliveryType: 48,
    defaultItemType: 2,
    defaultItemWeight: 0.5,
  },
  steadfast: {
    defaultCodAmount: 0,
  },
};

interface DeliveryProvidersContainerProps {
  providers: DeliveryProviderRecord[];
  apiBaseUrl?: string;
}

const DeliveryProvidersContainer: FC<DeliveryProvidersContainerProps> = ({
  providers: initialProviders,
  apiBaseUrl = "",
}) => {
  const queryClient = useQueryClient();
  const [providers, setProviders] =
    useState<DeliveryProviderRecord[]>(initialProviders);
  const [selectedProvider, setSelectedProvider] =
    useState<DeliveryProviderRecord | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTestingCredentials, setIsTestingCredentials] = useState(false);
  const [copiedWebhookUrl, setCopiedWebhookUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [formData, setFormData] = useState<
    Omit<DeliveryProviderRecord, "createdAt" | "updatedAt">
  >({
    id: "",
    name: "",
    type: "pathao",
    credentials: JSON.stringify(DEFAULT_CREDENTIALS.pathao),
    config: JSON.stringify(DEFAULT_CONFIG.pathao),
    isActive: false,
  });

  const parseJSON = (jsonString: string, fallback: Record<string, unknown> = {}) => {
    try {
      return JSON.parse(jsonString);
    } catch {
      return fallback;
    }
  };

  const creds = parseJSON(formData.credentials);
  const conf = parseJSON(formData.config);

  const refreshDeliveryProviderQueries = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.settings.deliveryProviders(),
    });
  };

  const resetForm = (provider?: DeliveryProviderRecord) => {
    if (provider) {
      setFormData({
        id: provider.id,
        name: provider.name,
        type: provider.type as DeliveryProviderType,
        credentials: provider.credentials,
        config: provider.config,
        isActive: provider.isActive,
      });
    } else {
      setFormData({
        id: crypto.randomUUID(),
        name: "",
        type: "pathao",
        credentials: JSON.stringify(DEFAULT_CREDENTIALS.pathao),
        config: JSON.stringify(DEFAULT_CONFIG.pathao),
        isActive: false,
      });
    }
  };

  const handleTypeChange = (type: DeliveryProviderType) => {
    let credentials = formData.credentials;
    let config = formData.config;
    try {
      if (type !== formData.type) {
        credentials = JSON.stringify(DEFAULT_CREDENTIALS[type]);
        config = JSON.stringify(DEFAULT_CONFIG[type]);
      }
    } catch {
      credentials = JSON.stringify(DEFAULT_CREDENTIALS[type]);
      config = JSON.stringify(DEFAULT_CONFIG[type]);
    }
    setFormData((prev) => ({ ...prev, type, credentials, config }));
  };

  const handleChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleCredentialChange = (field: string, value: string) => {
    try {
      const credentials = JSON.parse(formData.credentials);
      credentials[field] = value;
      setFormData((prev) => ({
        ...prev,
        credentials: JSON.stringify(credentials),
      }));
    } catch { /* empty */ }
  };

  const handleConfigChange = (field: string, value: string | number) => {
    try {
      const config = JSON.parse(formData.config);
      config[field] = value;
      setFormData((prev) => ({
        ...prev,
        config: JSON.stringify(config),
      }));
    } catch { /* empty */ }
  };

  const handleSave = async () => {
    if (!formData.name) {
      toast.error("Provider name is required");
      return;
    }
    setIsSaving(true);
    try {
      const savedProvider = await saveDeliveryProvider({
        data: { provider: formData },
      }) as DeliveryProviderRecord;
      if (isCreating) {
        setProviders((prev) => [...prev, savedProvider]);
      } else {
        setProviders((prev) =>
          prev.map((p) => (p.id === savedProvider.id ? savedProvider : p)),
        );
      }
      setSelectedProvider(savedProvider);
      setIsEditing(false);
      setIsCreating(false);
      refreshDeliveryProviderQueries();
      toast.success("Provider saved successfully");
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to save provider"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProvider) return;
    setIsDeleting(true);
    try {
      await deleteDeliveryProvider({ data: { id: selectedProvider.id } });
      setProviders((prev) =>
        prev.filter((p) => p.id !== selectedProvider.id),
      );
      refreshDeliveryProviderQueries();
      toast.success("Provider deleted");
      setSelectedProvider(null);
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to delete provider"));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTest = async () => {
    if (!selectedProvider) return;
    setIsTesting(true);
    try {
      const result = await testDeliveryProvider({
        data: { id: selectedProvider.id },
      }) as { success: boolean; message?: string };
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to test provider connection"));
    } finally {
      setIsTesting(false);
    }
  };

  const handleTestCredentials = async () => {
    if (!formData.type || !formData.credentials || !formData.config) {
      toast.error("Provider type, credentials, and config are required");
      return;
    }
    setIsTestingCredentials(true);
    try {
      let credentials, config;
      try {
        credentials = JSON.parse(formData.credentials);
        config = JSON.parse(formData.config);
      } catch {
        toast.error("Invalid credentials or config format");
        return;
      }
      const result = await testDeliveryCredentials({
        data: { type: formData.type, credentials, config, name: "Credential Test" },
      }) as { success: boolean; message?: string };
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to test credentials"));
    } finally {
      setIsTestingCredentials(false);
    }
  };

  const handleCreate = () => {
    resetForm();
    setIsCreating(true);
    setIsEditing(true);
    setSelectedProvider(null);
  };

  const handleEdit = () => {
    if (!selectedProvider) return;
    resetForm(selectedProvider);
    setIsEditing(true);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setIsCreating(false);
    if (selectedProvider) resetForm(selectedProvider);
  };

  const handleSelect = (provider: DeliveryProviderRecord) => {
    setSelectedProvider(provider);
    resetForm(provider);
    setIsEditing(false);
    setIsCreating(false);
  };

  const getWebhookUrl = (providerType: string) => {
    const base = apiBaseUrl ||
      (typeof window !== "undefined"
        ? window.location.origin.replace("dashboard.", "api.").replace(":4323", ":8787")
        : "");
    return `${base}/api/v1/webhooks/${providerType}`;
  };

  const generateWebhookSecret = () => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
  };

  const handleGenerateSecret = () => {
    const newSecret = generateWebhookSecret();
    handleCredentialChange("webhookSecret", newSecret);
    toast.success("New webhook secret generated. Save to apply, then copy and paste into your provider dashboard.");
  };

  const handleCopyWebhookUrl = async () => {
    const url = getWebhookUrl(formData.type);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedWebhookUrl(true);
      toast.success("Webhook URL copied to clipboard");
      setTimeout(() => setCopiedWebhookUrl(false), 2000);
    } catch {
      toast.error("Failed to copy URL");
    }
  };

  const handleCopySecret = async () => {
    const secret = creds.webhookSecret;
    if (!secret) {
      toast.error("Generate a secret first");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopiedSecret(true);
      toast.success("Webhook secret copied to clipboard");
      setTimeout(() => setCopiedSecret(false), 2000);
    } catch {
      toast.error("Failed to copy secret");
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <ProviderListSidebar
        providers={providers}
        selectedProviderId={selectedProvider?.id || null}
        onSelect={handleSelect}
        onCreate={handleCreate}
      />

      <ProviderDetailPanel
        selectedProvider={selectedProvider}
        isEditing={isEditing}
        isCreating={isCreating}
        isTesting={isTesting}
        isSaving={isSaving}
        isDeleting={isDeleting}
        isTestingCredentials={isTestingCredentials}
        copiedWebhookUrl={copiedWebhookUrl}
        copiedSecret={copiedSecret}
        formData={formData}
        creds={creds}
        conf={conf}
        onEdit={handleEdit}
        onTest={handleTest}
        onDelete={handleDelete}
        onSave={handleSave}
        onTestCredentials={handleTestCredentials}
        onCancel={handleCancel}
        onChangeField={handleChange}
        onChangeType={handleTypeChange}
        onChangeCredential={handleCredentialChange}
        onChangeConfig={handleConfigChange}
        getWebhookUrl={getWebhookUrl}
        onCopyWebhookUrl={handleCopyWebhookUrl}
        onCopySecret={handleCopySecret}
        onGenerateSecret={handleGenerateSecret}
      />
    </div>
  );
};

export { DeliveryProvidersContainer };
