import { type FC, useState } from "react";
import type { DeliveryProviderRecord, DeliveryProviderType } from "@/db/schema";
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
} from "lucide-react";

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
  },
  steadfast: {
    baseUrl: "https://portal.steadfast.com.bd/api/v1",
    apiKey: "",
    secretKey: "",
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
}

// API helpers (replaces the old window.deliveryProviderActions inline script)
async function apiSaveProvider(provider: any) {
  const method = provider.id ? "PUT" : "POST";
  const response = await fetch("/api/settings/delivery-providers", {
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
  const response = await fetch(`/api/settings/delivery-providers/${id}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to delete provider");
  }
  return true;
}

async function apiTestProvider(id: string) {
  const response = await fetch(`/api/settings/delivery-providers/${id}`, {
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
    "/api/settings/delivery-providers/create-test",
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

  const creds = parseJSON(formData.credentials);
  const conf = parseJSON(formData.config);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {/* Provider List Sidebar */}
      <Card className="md:col-span-1">
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
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{provider.name}</span>
                    <Badge
                      variant={provider.isActive ? "default" : "secondary"}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {provider.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground capitalize">
                    {provider.type}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
              <div>
                <CardTitle className="text-base">
                  {isCreating ? "New Provider" : "Provider Details"}
                </CardTitle>
                <CardDescription>
                  {isCreating
                    ? "Configure a new delivery integration"
                    : formData.name}
                </CardDescription>
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
                              {type.label}
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
