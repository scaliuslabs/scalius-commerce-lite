import { type FC, useState } from "react";
import type { DeliveryProvider, DeliveryProviderType } from "@/db/schema";
import { toast } from "sonner";

// Provider type options
const PROVIDER_TYPES: { value: DeliveryProviderType; label: string }[] = [
  { value: "pathao", label: "Pathao" },
  { value: "steadfast", label: "Steadfast" },
];

// Default credentials by provider type
const DEFAULT_CREDENTIALS = {
  pathao: {
    baseUrl: "https://api-hermes.pathao.com",
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
  },
  steadfast: {
    baseUrl: "https://portal.packzy.com/api/v1",
    apiKey: "",
    secretKey: "",
  },
};

// Default config by provider type
const DEFAULT_CONFIG = {
  pathao: {
    storeId: "",
    defaultDeliveryType: 48, // Regular delivery
    defaultItemType: 2, // Parcel
    defaultItemWeight: 0.5, // 0.5 KG
  },
  steadfast: {
    defaultCodAmount: 0,
  },
};

interface DeliveryProviderSettingsProps {
  providers: DeliveryProvider[];
}

declare global {
  interface Window {
    deliveryProviderActions: {
      saveProvider: (provider: any) => Promise<any>;
      deleteProvider: (id: string) => Promise<boolean>;
      testProvider: (id: string) => Promise<any>;
      testCredentials: (
        type: string,
        credentials: any,
        config: any,
      ) => Promise<any>;
    };
  }
}

const DeliveryProviderSettings: FC<DeliveryProviderSettingsProps> = ({
  providers: initialProviders,
}) => {
  const [providers, setProviders] =
    useState<DeliveryProvider[]>(initialProviders);
  const [selectedProvider, setSelectedProvider] =
    useState<DeliveryProvider | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isTestingCredentials, setIsTestingCredentials] = useState(false);

  // Form state
  const [formData, setFormData] = useState<
    Omit<DeliveryProvider, "createdAt" | "updatedAt">
  >({
    id: "",
    name: "",
    type: "pathao",
    credentials: JSON.stringify(DEFAULT_CREDENTIALS.pathao),
    config: JSON.stringify(DEFAULT_CONFIG.pathao),
    isActive: false,
  });

  // Reset form to selected provider or default values
  const resetForm = (provider?: DeliveryProvider) => {
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

  // Handle provider type change
  const handleTypeChange = (type: DeliveryProviderType) => {
    let credentials = formData.credentials;
    let config = formData.config;

    try {
      // If we're changing provider type, reset to defaults
      if (type !== formData.type) {
        credentials = JSON.stringify(DEFAULT_CREDENTIALS[type]);
        config = JSON.stringify(DEFAULT_CONFIG[type]);
      }
    } catch (error) {
      console.error("Error parsing form data", error);
      credentials = JSON.stringify(DEFAULT_CREDENTIALS[type]);
      config = JSON.stringify(DEFAULT_CONFIG[type]);
    }

    setFormData((prev) => ({
      ...prev,
      type,
      credentials,
      config,
    }));
  };

  // Handle form field changes
  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  // Handle credential changes
  const handleCredentialChange = (field: string, value: any) => {
    try {
      const credentials = JSON.parse(formData.credentials);
      credentials[field] = value;
      setFormData((prev) => ({
        ...prev,
        credentials: JSON.stringify(credentials),
      }));
    } catch (error) {
      console.error("Error updating credentials", error);
    }
  };

  // Handle config changes
  const handleConfigChange = (field: string, value: any) => {
    try {
      const config = JSON.parse(formData.config);
      config[field] = value;
      setFormData((prev) => ({
        ...prev,
        config: JSON.stringify(config),
      }));
    } catch (error) {
      console.error("Error updating config", error);
    }
  };

  // Save provider
  const handleSave = async () => {
    if (!formData.name) {
      toast.error("Provider name is required");
      return;
    }

    setIsSaving(true);
    try {
      if (!window.deliveryProviderActions) {
        toast.error("Provider actions not available");
        return;
      }

      // Call API to save provider
      const savedProvider =
        await window.deliveryProviderActions.saveProvider(formData);

      // Update local state
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
      toast.success("Provider saved successfully");
    } catch (error) {
      toast.error(
        `Error saving provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsSaving(false);
    }
  };

  // Delete provider
  const handleDelete = async () => {
    if (!selectedProvider) return;

    if (!confirm(`Are you sure you want to delete ${selectedProvider.name}?`)) {
      return;
    }

    setIsDeleting(true);
    try {
      if (!window.deliveryProviderActions) {
        toast.error("Provider actions not available");
        return;
      }

      await window.deliveryProviderActions.deleteProvider(selectedProvider.id);

      // Update local state
      setProviders((prev) => prev.filter((p) => p.id !== selectedProvider.id));
      toast.success("Provider deleted");
      setSelectedProvider(null);
    } catch (error) {
      toast.error(
        `Error deleting provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsDeleting(false);
    }
  };

  // Test provider connection
  const handleTest = async () => {
    if (!selectedProvider) return;

    setIsTesting(true);
    try {
      if (!window.deliveryProviderActions) {
        toast.error("Provider actions not available");
        return;
      }

      console.log(
        `Testing provider connection for: ${selectedProvider.name} (${selectedProvider.id})`,
      );
      const result = await window.deliveryProviderActions.testProvider(
        selectedProvider.id,
      );

      console.log("Test provider response:", result);

      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      console.error("Error testing provider connection:", error);
      toast.error(
        `Error testing provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsTesting(false);
    }
  };

  // Test current credentials in the form without saving
  const handleTestCredentials = async () => {
    if (!formData.type || !formData.credentials || !formData.config) {
      toast.error("Provider type, credentials, and config are required");
      return;
    }

    setIsTestingCredentials(true);
    try {
      if (!window.deliveryProviderActions) {
        toast.error("Provider actions not available");
        return;
      }

      // Extract credentials and config as objects
      let credentials;
      let config;

      try {
        credentials = JSON.parse(formData.credentials);
        config = JSON.parse(formData.config);
      } catch (error) {
        toast.error("Invalid credentials or config format");
        return;
      }

      console.log(
        `Testing current credentials for ${formData.type} provider before saving`,
      );

      const result = await window.deliveryProviderActions.testCredentials(
        formData.type,
        credentials,
        config,
      );

      console.log("Test credentials response:", result);

      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      console.error("Error testing credentials:", error);
      toast.error(
        `Error testing credentials: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsTestingCredentials(false);
    }
  };

  // Start creating a new provider
  const handleCreate = () => {
    resetForm();
    setIsCreating(true);
    setIsEditing(true);
    setSelectedProvider(null);
  };

  // Start editing the selected provider
  const handleEdit = () => {
    if (!selectedProvider) return;
    resetForm(selectedProvider);
    setIsEditing(true);
    setIsCreating(false);
  };

  // Cancel editing
  const handleCancel = () => {
    setIsEditing(false);
    setIsCreating(false);
    if (selectedProvider) {
      resetForm(selectedProvider);
    }
  };

  // Select a provider
  const handleSelect = (provider: DeliveryProvider) => {
    setSelectedProvider(provider);
    resetForm(provider);
    setIsEditing(false);
    setIsCreating(false);
  };

  // Parse JSON for display
  const parseJSON = (jsonString: string, fallback: any = {}) => {
    try {
      return JSON.parse(jsonString);
    } catch (error) {
      console.error("Error parsing JSON", error);
      return fallback;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Delivery Providers</h2>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-foreground text-background rounded hover:bg-primary/90 transition-colors"
        >
          Add Provider
        </button>
      </div>

      {/* Provider List */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="col-span-1 border rounded p-4">
          <h3 className="font-medium mb-4">Available Providers</h3>
          {providers.length === 0 ? (
            <p className="text-gray-500">No providers configured</p>
          ) : (
            <ul className="space-y-2">
              {providers.map((provider) => (
                <li
                  key={provider.id}
                  className={`p-2 rounded cursor-pointer ${
                    selectedProvider?.id === provider.id
                      ? "bg-background border border-gray-300"
                      : "hover:bg-background border border-transparent"
                  }`}
                  onClick={() => handleSelect(provider)}
                >
                  <div className="flex items-center space-x-2 ">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        provider.isActive ? "bg-green-500" : "bg-gray-300"
                      }`}
                    ></span>
                    <span className="font-medium">{provider.name}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {provider.type}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Provider Details */}
        <div className="col-span-1 md:col-span-2 border rounded p-4">
          <h3 className="font-medium mb-4">
            {isCreating
              ? "New Provider"
              : selectedProvider
                ? "Provider Details"
                : "Select a Provider"}
          </h3>

          {(selectedProvider || isCreating) && (
            <div className="space-y-4">
              {/* Provider Form */}
              <div className="space-y-6">
                {/* Basic Information */}
                <div>
                  <h4 className="font-medium mb-2">Basic Information</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Name
                      </label>
                      {isEditing ? (
                        <input
                          type="text"
                          value={formData.name}
                          onChange={(e) => handleChange("name", e.target.value)}
                          className="w-full p-2 border rounded"
                          disabled={!isEditing}
                        />
                      ) : (
                        <p>{formData.name}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Type
                      </label>
                      {isEditing ? (
                        <select
                          value={formData.type}
                          onChange={(e) =>
                            handleTypeChange(
                              e.target.value as DeliveryProviderType,
                            )
                          }
                          className="w-full p-2 border rounded"
                          disabled={!isEditing}
                        >
                          {PROVIDER_TYPES.map((type) => (
                            <option key={type.value} value={type.value}>
                              {type.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p>
                          {
                            PROVIDER_TYPES.find(
                              (type) => type.value === formData.type,
                            )?.label
                          }
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Status
                      </label>
                      {isEditing ? (
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            checked={formData.isActive}
                            onChange={(e) =>
                              handleChange("isActive", e.target.checked)
                            }
                            className="rounded"
                            id="provider-active"
                          />
                          <label
                            htmlFor="provider-active"
                            className="text-sm select-none"
                          >
                            Active
                          </label>
                        </div>
                      ) : (
                        <p>
                          {formData.isActive ? (
                            <span className="text-green-600 font-medium">
                              Active
                            </span>
                          ) : (
                            <span className="text-gray-600">Inactive</span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Credentials Section */}
                <div>
                  <h4 className="font-medium mb-2">API Credentials</h4>

                  {formData.type === "pathao" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Base URL
                        </label>
                        {isEditing ? (
                          <input
                            type="text"
                            value={
                              parseJSON(formData.credentials).baseUrl || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange("baseUrl", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.credentials).baseUrl}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Client ID
                        </label>
                        {isEditing ? (
                          <input
                            type="text"
                            value={
                              parseJSON(formData.credentials).clientId || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange("clientId", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>••••••••••••</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Client Secret
                        </label>
                        {isEditing ? (
                          <input
                            type="password"
                            value={
                              parseJSON(formData.credentials).clientSecret || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange(
                                "clientSecret",
                                e.target.value,
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>••••••••••••</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Username
                        </label>
                        {isEditing ? (
                          <input
                            type="text"
                            value={
                              parseJSON(formData.credentials).username || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange("username", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.credentials).username}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Password
                        </label>
                        {isEditing ? (
                          <input
                            type="password"
                            value={
                              parseJSON(formData.credentials).password || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange("password", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>••••••••••••</p>
                        )}
                      </div>
                    </div>
                  )}

                  {formData.type === "steadfast" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Base URL
                        </label>
                        {isEditing ? (
                          <input
                            type="text"
                            value={
                              parseJSON(formData.credentials).baseUrl || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange("baseUrl", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.credentials).baseUrl}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          API Key
                        </label>
                        {isEditing ? (
                          <input
                            type="password"
                            value={parseJSON(formData.credentials).apiKey || ""}
                            onChange={(e) =>
                              handleCredentialChange("apiKey", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>••••••••••••</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Secret Key
                        </label>
                        {isEditing ? (
                          <input
                            type="password"
                            value={
                              parseJSON(formData.credentials).secretKey || ""
                            }
                            onChange={(e) =>
                              handleCredentialChange(
                                "secretKey",
                                e.target.value,
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>••••••••••••</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Configuration Section */}
                <div>
                  <h4 className="font-medium mb-2">Configuration</h4>

                  {formData.type === "pathao" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Store ID
                        </label>
                        {isEditing ? (
                          <input
                            type="text"
                            value={parseJSON(formData.config).storeId || ""}
                            onChange={(e) =>
                              handleConfigChange("storeId", e.target.value)
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.config).storeId}</p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Default Delivery Type
                        </label>
                        {isEditing ? (
                          <select
                            value={
                              parseJSON(formData.config).defaultDeliveryType ||
                              48
                            }
                            onChange={(e) =>
                              handleConfigChange(
                                "defaultDeliveryType",
                                Number(e.target.value),
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          >
                            <option value={48}>Regular (48)</option>
                            <option value={12}>Express (12)</option>
                          </select>
                        ) : (
                          <p>
                            {parseJSON(formData.config).defaultDeliveryType ===
                            12
                              ? "Express (12)"
                              : "Regular (48)"}
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Default Item Type
                        </label>
                        {isEditing ? (
                          <select
                            value={
                              parseJSON(formData.config).defaultItemType || 2
                            }
                            onChange={(e) =>
                              handleConfigChange(
                                "defaultItemType",
                                Number(e.target.value),
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          >
                            <option value={1}>Document</option>
                            <option value={2}>Parcel</option>
                          </select>
                        ) : (
                          <p>
                            {parseJSON(formData.config).defaultItemType === 1
                              ? "Document"
                              : "Parcel"}
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Default Weight (KG)
                        </label>
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.1"
                            min="0.1"
                            value={
                              parseJSON(formData.config).defaultItemWeight ||
                              0.5
                            }
                            onChange={(e) =>
                              handleConfigChange(
                                "defaultItemWeight",
                                Number(e.target.value),
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.config).defaultItemWeight}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {formData.type === "steadfast" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium mb-1">
                          Default COD Amount
                        </label>
                        {isEditing ? (
                          <input
                            type="number"
                            min="0"
                            value={
                              parseJSON(formData.config).defaultCodAmount || 0
                            }
                            onChange={(e) =>
                              handleConfigChange(
                                "defaultCodAmount",
                                Number(e.target.value),
                              )
                            }
                            className="w-full p-2 border rounded"
                            disabled={!isEditing}
                          />
                        ) : (
                          <p>{parseJSON(formData.config).defaultCodAmount}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Form Actions */}
                <div className="flex space-x-2 pt-4">
                  {isEditing ? (
                    <>
                      <button
                        onClick={handleSave}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isSaving}
                      >
                        {isSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleTestCredentials}
                        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isTestingCredentials}
                      >
                        {isTestingCredentials
                          ? "Testing..."
                          : "Test Credentials"}
                      </button>
                      <button
                        onClick={handleCancel}
                        className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={handleEdit}
                        className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={handleTest}
                        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isTesting}
                      >
                        {isTesting ? "Testing..." : "Test Connection"}
                      </button>
                      <button
                        onClick={handleDelete}
                        className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={isDeleting}
                      >
                        {isDeleting ? "Deleting..." : "Delete"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {!selectedProvider && !isCreating && (
            <p className="text-gray-500">
              Select a provider to view details or create a new one.
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export { DeliveryProviderSettings };
