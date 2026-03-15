import { type FC, useState } from "react";
import type { DeliveryProviderRecord, DeliveryProviderType } from "@scalius/database/schema";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  TestTube,
  Save,
  X,
  Truck,
  Package,
  Copy,
  Check,
  Webhook,
  Info,
} from "lucide-react";

// Provider visual config: icon, color scheme, and description
const PROVIDER_VISUAL: Record<
  string,
  {
    icon: typeof Truck;
    bgClass: string;
    iconClass: string;
    badgeClass: string;
    description: string;
  }
> = {
  pathao: {
    icon: Truck,
    bgClass: "bg-orange-100 dark:bg-orange-950/40",
    iconClass: "text-orange-600 dark:text-orange-400",
    badgeClass: "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400 border-orange-200 dark:border-orange-900",
    description: "Ride-sharing & delivery platform",
  },
  steadfast: {
    icon: Package,
    bgClass: "bg-blue-100 dark:bg-blue-950/40",
    iconClass: "text-blue-600 dark:text-blue-400",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400 border-blue-200 dark:border-blue-900",
    description: "Courier & logistics service",
  },
};

function ProviderIcon({
  type,
  size = "md",
}: {
  type: string;
  size?: "sm" | "md" | "lg";
}) {
  const visual = PROVIDER_VISUAL[type] || PROVIDER_VISUAL.pathao;
  const Icon = visual.icon;
  const sizeClasses = {
    sm: "p-1.5 rounded-md",
    md: "p-2 rounded-lg",
    lg: "p-3 rounded-xl",
  };
  const iconSizes = {
    sm: "h-3.5 w-3.5",
    md: "h-5 w-5",
    lg: "h-7 w-7",
  };
  return (
    <div className={`flex-shrink-0 ${visual.bgClass} ${sizeClasses[size]}`}>
      <Icon className={`${iconSizes[size]} ${visual.iconClass}`} />
    </div>
  );
}

// Provider type options
const PROVIDER_TYPES: { value: DeliveryProviderType; label: string }[] = [
  { value: "pathao", label: "Pathao" },
  { value: "steadfast", label: "Steadfast" },
];

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

interface DeliveryProviderSettingsProps {
  providers: DeliveryProviderRecord[];
  apiBaseUrl?: string;
}

// API helpers (replaces the old window.deliveryProviderActions inline script)
async function apiSaveProvider(provider: any) {
  const method = provider.id ? "PUT" : "POST";
  const response = await fetch("/api/v1/admin/settings/delivery-providers", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(provider),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to save provider");
  }
  return response.json();
}

async function apiDeleteProvider(id: string) {
  const response = await fetch(`/api/v1/admin/settings/delivery-providers/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to delete provider");
  }
  return true;
}

async function apiTestProvider(id: string) {
  const response = await fetch(`/api/v1/admin/settings/delivery-providers/${id}`, {
    method: "POST",
  });
  if (!response.ok) {
    const errorData = await response
      .json()
      .catch(() => ({ error: "Failed to parse error response" }));
    return {
      success: false,
      message: errorData.error || "Failed to test provider connection",
    };
  }
  return response.json();
}

async function apiTestCredentials(
  type: string,
  credentials: any,
  config: any
) {
  const response = await fetch(
    "/api/v1/admin/settings/delivery-providers/create-test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        credentials,
        config,
        name: "Credential Test",
      }),
    }
  );
  const result = await response.json();
  if (!response.ok) {
    return {
      success: false,
      message: result.error || "Failed to test credentials",
    };
  }
  return result;
}

const DeliveryProviderSettings: FC<DeliveryProviderSettingsProps> = ({
  providers: initialProviders,
  apiBaseUrl = "",
}) => {
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

  // Form state
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

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleCredentialChange = (field: string, value: any) => {
    try {
      const credentials = JSON.parse(formData.credentials);
      credentials[field] = value;
      setFormData((prev) => ({
        ...prev,
        credentials: JSON.stringify(credentials),
      }));
    } catch { }
  };

  const handleConfigChange = (field: string, value: any) => {
    try {
      const config = JSON.parse(formData.config);
      config[field] = value;
      setFormData((prev) => ({
        ...prev,
        config: JSON.stringify(config),
      }));
    } catch { }
  };

  const handleSave = async () => {
    if (!formData.name) {
      toast.error("Provider name is required");
      return;
    }
    setIsSaving(true);
    try {
      const savedProvider = await apiSaveProvider(formData);
      if (isCreating) {
        setProviders((prev) => [...prev, savedProvider]);
      } else {
        setProviders((prev) =>
          prev.map((p) => (p.id === savedProvider.id ? savedProvider : p))
        );
      }
      setSelectedProvider(savedProvider);
      setIsEditing(false);
      setIsCreating(false);
      toast.success("Provider saved successfully");
    } catch (error) {
      toast.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProvider) return;
    setIsDeleting(true);
    try {
      await apiDeleteProvider(selectedProvider.id);
      setProviders((prev) =>
        prev.filter((p) => p.id !== selectedProvider.id)
      );
      toast.success("Provider deleted");
      setSelectedProvider(null);
    } catch (error) {
      toast.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTest = async () => {
    if (!selectedProvider) return;
    setIsTesting(true);
    try {
      const result = await apiTestProvider(selectedProvider.id);
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      toast.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
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
      const result = await apiTestCredentials(formData.type, credentials, config);
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      toast.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`
      );
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

  const parseJSON = (jsonString: string, fallback: any = {}) => {
    try {
      return JSON.parse(jsonString);
    } catch {
      return fallback;
    }
  };

  const getWebhookUrl = (providerType: string) => {
    // Webhook URL must point to the PUBLIC API worker, not the admin dashboard.
    // apiBaseUrl is passed from server-side (runtime Cloudflare env.PUBLIC_API_BASE_URL).
    // Fallback: derive from admin origin for dev (dashboard. → api., :4321 → :8787).
    const base = apiBaseUrl ||
      (typeof window !== "undefined"
        ? window.location.origin.replace("dashboard.", "api.").replace(":4321", ":8787")
        : "");
    return `${base}/api/v1/webhooks/${providerType}`;
  };

  const generateWebhookSecret = () => {
    // Generate a cryptographically secure random secret
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

  const creds = parseJSON(formData.credentials);
  const conf = parseJSON(formData.config);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* Provider List Sidebar */}
      <div className="md:col-span-1 space-y-4">
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Providers</CardTitle>
            <Button size="sm" onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {providers.length === 0 ? (
              <div className="px-6 pb-6 text-sm text-muted-foreground">
                No providers configured yet.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {providers.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => handleSelect(provider)}
                    className={`w-full text-left px-4 py-3 transition-colors hover:bg-muted/50 ${selectedProvider?.id === provider.id
                      ? "bg-muted/60 border-l-2 border-l-primary"
                      : "border-l-2 border-l-transparent"
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      <ProviderIcon type={provider.type} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">
                            {provider.name}
                          </span>
                          <Badge
                            variant={provider.isActive ? "default" : "secondary"}
                            className="text-[10px] px-1.5 py-0 flex-shrink-0"
                          >
                            {provider.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 font-normal capitalize ${PROVIDER_VISUAL[provider.type]?.badgeClass || ""}`}
                          >
                            {provider.type}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Supported Providers */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Supported Providers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 pt-0">
            {PROVIDER_TYPES.map((pt) => {
              const visual = PROVIDER_VISUAL[pt.value];
              return (
                <div key={pt.value} className="flex items-center gap-2.5">
                  <ProviderIcon type={pt.value} size="sm" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-tight">{pt.label}</p>
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {visual?.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {/* Provider Detail Panel */}
      <Card className="md:col-span-2">
        {!selectedProvider && !isCreating ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Truck className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">
              Select a provider or add a new one to get started.
            </p>
          </div>
        ) : (
          <>
            <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-3">
                <ProviderIcon type={formData.type} size="md" />
                <div>
                  <CardTitle className="text-base">
                    {isCreating ? "New Provider" : formData.name || "Provider Details"}
                  </CardTitle>
                  <CardDescription>
                    {isCreating
                      ? "Configure a new delivery integration"
                      : PROVIDER_VISUAL[formData.type]?.description || formData.type}
                  </CardDescription>
                </div>
              </div>
              {!isEditing && selectedProvider && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleEdit}>
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleTest}
                    disabled={isTesting}
                  >
                    {isTesting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <TestTube className="h-3.5 w-3.5 mr-1" />
                    )}
                    Test
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" size="sm" disabled={isDeleting}>
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                        )}
                        Delete
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete provider?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This will permanently remove{" "}
                          <strong>{selectedProvider.name}</strong> and all its
                          configuration. This action cannot be undone.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={handleDelete}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Basic Information */}
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Basic Information
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="provider-name">Name</Label>
                    <Input
                      id="provider-name"
                      value={formData.name}
                      onChange={(e) => handleChange("name", e.target.value)}
                      disabled={!isEditing}
                      placeholder="e.g. Pathao Production"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Type</Label>
                    {isEditing ? (
                      <Select
                        value={formData.type}
                        onValueChange={(val) =>
                          handleTypeChange(val as DeliveryProviderType)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PROVIDER_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                              <span className="flex items-center gap-2">
                                {type.label}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={
                          PROVIDER_TYPES.find((t) => t.value === formData.type)
                            ?.label || formData.type
                        }
                        disabled
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between sm:col-span-2">
                    <div className="space-y-0.5">
                      <Label>Status</Label>
                      <p className="text-xs text-muted-foreground">
                        Enable to make this provider available for orders
                      </p>
                    </div>
                    <Switch
                      checked={formData.isActive}
                      onCheckedChange={(checked) =>
                        handleChange("isActive", checked)
                      }
                      disabled={!isEditing}
                    />
                  </div>
                </div>
              </div>

              {/* Credentials */}
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  API Credentials
                </h4>

                {formData.type === "pathao" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Base URL</Label>
                      <Input
                        value={creds.baseUrl || ""}
                        onChange={(e) =>
                          handleCredentialChange("baseUrl", e.target.value)
                        }
                        disabled={!isEditing}
                        placeholder="https://api-hermes.pathao.com"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Client ID</Label>
                      <Input
                        value={creds.clientId || ""}
                        onChange={(e) =>
                          handleCredentialChange("clientId", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Client Secret</Label>
                      <Input
                        type="password"
                        value={creds.clientSecret || ""}
                        onChange={(e) =>
                          handleCredentialChange("clientSecret", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Username</Label>
                      <Input
                        value={creds.username || ""}
                        onChange={(e) =>
                          handleCredentialChange("username", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>Password</Label>
                      <Input
                        type="password"
                        value={creds.password || ""}
                        onChange={(e) =>
                          handleCredentialChange("password", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                  </div>
                )}

                {formData.type === "steadfast" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>Base URL</Label>
                      <Input
                        value={creds.baseUrl || ""}
                        onChange={(e) =>
                          handleCredentialChange("baseUrl", e.target.value)
                        }
                        disabled={!isEditing}
                        placeholder="https://portal.steadfast.com.bd/api/v1"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        value={creds.apiKey || ""}
                        onChange={(e) =>
                          handleCredentialChange("apiKey", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Secret Key</Label>
                      <Input
                        type="password"
                        value={creds.secretKey || ""}
                        onChange={(e) =>
                          handleCredentialChange("secretKey", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                  </div>
                )}

              </div>

              {/* Configuration Section */}
              <div className="space-y-4">
                <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                  Configuration
                </h4>

                {formData.type === "pathao" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Store ID</Label>
                      <Input
                        value={conf.storeId || ""}
                        onChange={(e) =>
                          handleConfigChange("storeId", e.target.value)
                        }
                        disabled={!isEditing}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Default Delivery Type</Label>
                      {isEditing ? (
                        <Select
                          value={String(conf.defaultDeliveryType || 48)}
                          onValueChange={(val) =>
                            handleConfigChange("defaultDeliveryType", Number(val))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="48">Regular (48hr)</SelectItem>
                            <SelectItem value="12">Express (12hr)</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={
                            conf.defaultDeliveryType === 12
                              ? "Express (12hr)"
                              : "Regular (48hr)"
                          }
                          disabled
                        />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label>Default Item Type</Label>
                      {isEditing ? (
                        <Select
                          value={String(conf.defaultItemType || 2)}
                          onValueChange={(val) =>
                            handleConfigChange("defaultItemType", Number(val))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">Document</SelectItem>
                            <SelectItem value="2">Parcel</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={
                            conf.defaultItemType === 1 ? "Document" : "Parcel"
                          }
                          disabled
                        />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label>Default Weight (KG)</Label>
                      <Input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={conf.defaultItemWeight || 0.5}
                        onChange={(e) =>
                          handleConfigChange(
                            "defaultItemWeight",
                            Number(e.target.value)
                          )
                        }
                        disabled={!isEditing}
                      />
                    </div>
                  </div>
                )}

                {formData.type === "steadfast" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label>Default COD Amount</Label>
                      <Input
                        type="number"
                        min="0"
                        value={conf.defaultCodAmount || 0}
                        onChange={(e) =>
                          handleConfigChange(
                            "defaultCodAmount",
                            Number(e.target.value)
                          )
                        }
                        disabled={!isEditing}
                      />
                    </div>
                  </div>
                )}

              </div>

              {/* Webhook Configuration */}
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Webhook className="h-4 w-4 text-muted-foreground" />
                  <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Webhook Configuration
                  </h4>
                </div>

                <div className="space-y-4">
                  {/* Webhook URL (read-only with copy) */}
                  <div className="space-y-1.5">
                    <Label>Webhook Callback URL</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={getWebhookUrl(formData.type)}
                        readOnly
                        className="font-mono text-sm bg-muted/50"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="flex-shrink-0"
                        onClick={handleCopyWebhookUrl}
                      >
                        {copiedWebhookUrl ? (
                          <Check className="h-4 w-4 text-green-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Paste this URL into your {formData.type === "pathao" ? "Pathao" : "Steadfast"} dashboard webhook settings.
                    </p>
                  </div>

                  {/* Webhook Secret — auto-generated, copy to provider dashboard */}
                  <div className="space-y-1.5">
                    <Label>
                      {formData.type === "pathao" ? "Webhook Secret" : "Webhook Auth Token"}
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        value={creds.webhookSecret || ""}
                        readOnly
                        className="font-mono text-xs bg-muted/50"
                        placeholder="Click 'Generate' to create a secret"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="flex-shrink-0"
                        onClick={handleCopySecret}
                        disabled={!creds.webhookSecret}
                        title="Copy secret"
                      >
                        {copiedSecret ? (
                          <Check className="h-4 w-4 text-green-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="flex-shrink-0"
                        onClick={handleGenerateSecret}
                        disabled={!isEditing}
                        title={creds.webhookSecret ? "Regenerate secret (old one stops working)" : "Generate secret"}
                      >
                        {creds.webhookSecret ? "Roll" : "Generate"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {creds.webhookSecret
                        ? <>Copy this secret and paste it into your{" "}
                          {formData.type === "pathao" ? "Pathao" : "Steadfast"}{" "}
                          dashboard webhook settings.{" "}
                          Click &ldquo;Roll&rdquo; to regenerate (invalidates the old secret).</>
                        : "Generate a secret, save, then copy and paste it into your provider's dashboard."}
                    </p>
                  </div>

                  {/* Setup Instructions */}
                  <div className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-3">
                    <div className="flex gap-2">
                      <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                      <div className="text-sm text-blue-900 dark:text-blue-200">
                        {formData.type === "pathao" ? (
                          <p>
                            Go to your <strong>Pathao Merchant Dashboard</strong> &rarr; <strong>Settings</strong> &rarr; <strong>Webhook</strong>.
                            Paste the webhook URL above and enter your webhook secret. Pathao will send status updates
                            for orders including pickup, in-transit, delivered, and return events.
                          </p>
                        ) : (
                          <p>
                            Go to your <strong>Steadfast Dashboard</strong> &rarr; <strong>Settings</strong> &rarr; <strong>Webhook</strong>.
                            Set the <strong>Callback URL</strong> to the URL above and enter the <strong>Auth Token</strong>.
                            Steadfast will send delivery status and tracking updates to this endpoint.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Bar */}
              {isEditing && (
                <div className="flex items-center gap-2 pt-4 border-t border-border">
                  <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="min-w-[100px]"
                  >
                    {isSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <Save className="h-4 w-4 mr-1" />
                    )}
                    Save
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleTestCredentials}
                    disabled={isTestingCredentials}
                  >
                    {isTestingCredentials ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <TestTube className="h-4 w-4 mr-1" />
                    )}
                    Test Credentials
                  </Button>
                  <Button variant="ghost" onClick={handleCancel}>
                    <X className="h-4 w-4 mr-1" />
                    Cancel
                  </Button>
                </div>
              )}

              {/* Integration Guide Section */}
              <div className="pt-6 border-t border-border mt-6">
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="guide">
                    <AccordionTrigger className="text-sm font-medium text-muted-foreground uppercase tracking-wider py-2 hover:no-underline">
                      Integration Guide & Documentation
                    </AccordionTrigger>
                    <AccordionContent className="pt-4 text-muted-foreground">
                      {formData.type === "pathao" ? (
                        <div className="space-y-4">
                          <p><strong className="text-foreground">Pathao Courier Integration</strong></p>
                          <p>To use Pathao, you need to configure your API credentials and accurately map your internal delivery locations to Pathao's numeric IDs.</p>
                          <ul className="list-disc pl-5 space-y-2">
                            <li><strong className="text-foreground">Credentials:</strong> Obtain your Client ID, Client Secret, Username, and Password from the Pathao Merchant Portal.</li>
                            <li><strong className="text-foreground">Store ID:</strong> Your Pathao Store ID where shipments will be originated.</li>
                            <li><strong className="text-foreground">Locations Mapping (CRITICAL):</strong> Pathao requires precise numeric IDs for City, Zone, and Area. If you do not configure these in the <a href="/admin/settings/delivery-locations" className="text-primary hover:underline">Delivery Locations</a> page (in the <em>External IDs</em> JSON field mapping such as <code>{`{"pathao": 123}`}</code>), shipments will fail to create.</li>
                          </ul>
                          <p>Common IDs: Dhaka City (1), Chittagong City (2). Please refer to Pathao API docs for your specific zone and area IDs.</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <p><strong className="text-foreground">Steadfast Courier Integration</strong></p>
                          <p>To use Steadfast, provide your API Key and Secret Key obtained from the Steadfast Merchant Dashboard.</p>
                          <ul className="list-disc pl-5 space-y-2">
                            <li><strong className="text-foreground">Credentials:</strong> Generate <code>Api-Key</code> and <code>Secret-Key</code> from the Steadfast portal.</li>
                            <li><strong className="text-foreground">Base URL:</strong> Normally <code>https://portal.steadfast.com.bd/api/v1</code> or <code>https://portal.packzy.com/api/v1</code> depending on your account.</li>
                            <li><strong className="text-foreground">Location mapping:</strong> Steadfast does not strictly require predefined numeric area codes in the same way, but ensuring full text addresses are passed covers most routing.</li>
                          </ul>
                        </div>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
};

export { DeliveryProviderSettings };
