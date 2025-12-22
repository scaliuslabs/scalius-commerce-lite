import { type FC, useState } from "react";
import type { FraudCheckerProvider } from "@/lib/fraud-checker/service";
import { toast } from "sonner";

interface FraudCheckerSettingsProps {
  providers: FraudCheckerProvider[];
}

declare global {
  interface Window {
    fraudCheckerActions: {
      saveProvider: (provider: any) => Promise<any>;
      deleteProvider: (id: string) => Promise<boolean>;
      testProvider: (id: string) => Promise<any>;
    };
  }
}

const FraudCheckerSettings: FC<FraudCheckerSettingsProps> = ({
  providers: initialProviders,
}) => {
  const [providers, setProviders] = useState<FraudCheckerProvider[]>(initialProviders);
  const [selectedProvider, setSelectedProvider] = useState<FraudCheckerProvider | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [formData, setFormData] = useState<Omit<FraudCheckerProvider, "id"> & { id?: string }>({
    name: "",
    apiUrl: "https://fraudchecker.link/api/v1/qc/",
    apiKey: "",
    isActive: false,
  });

  const resetForm = (provider?: FraudCheckerProvider) => {
    if (provider) {
      setFormData(provider);
    } else {
      setFormData({
        name: "",
        apiUrl: "https://fraudchecker.link/api/v1/qc/",
        apiKey: "",
        isActive: false,
      });
    }
  };

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    if (!formData.name || !formData.apiUrl || !formData.apiKey) {
      toast.error("All fields are required");
      return;
    }

    setIsSaving(true);
    try {
      if (!window.fraudCheckerActions) {
        toast.error("Fraud checker actions not available");
        return;
      }

      const savedProvider = await window.fraudCheckerActions.saveProvider(formData);

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
      toast.error(`Error saving provider: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedProvider) return;

    if (!confirm(`Are you sure you want to delete ${selectedProvider.name}?`)) {
      return;
    }

    setIsDeleting(true);
    try {
      if (!window.fraudCheckerActions) {
        toast.error("Fraud checker actions not available");
        return;
      }

      await window.fraudCheckerActions.deleteProvider(selectedProvider.id);
      setProviders((prev) => prev.filter((p) => p.id !== selectedProvider.id));
      toast.success("Provider deleted");
      setSelectedProvider(null);
    } catch (error) {
      toast.error(`Error deleting provider: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTest = async () => {
    if (!selectedProvider) return;

    setIsTesting(true);
    try {
      if (!window.fraudCheckerActions) {
        toast.error("Fraud checker actions not available");
        return;
      }

      const result = await window.fraudCheckerActions.testProvider(selectedProvider.id);

      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error) {
      toast.error(`Error testing provider: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsTesting(false);
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
    if (selectedProvider) {
      resetForm(selectedProvider);
    }
  };

  const handleSelect = (provider: FraudCheckerProvider) => {
    setSelectedProvider(provider);
    resetForm(provider);
    setIsEditing(false);
    setIsCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Fraud Checker Providers</h2>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-foreground text-background rounded hover:bg-primary/90 transition-colors"
        >
          Add Provider
        </button>
      </div>

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
                  <div className="flex items-center space-x-2">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        provider.isActive ? "bg-green-500" : "bg-gray-300"
                      }`}
                    ></span>
                    <span className="font-medium">{provider.name}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="col-span-1 md:col-span-2 border rounded p-4">
          <h3 className="font-medium mb-4">
            {isCreating ? "New Provider" : selectedProvider ? "Provider Details" : "Select a Provider"}
          </h3>

          {(selectedProvider || isCreating) && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Name</label>
                {isEditing ? (
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleChange("name", e.target.value)}
                    className="w-full p-2 border rounded"
                  />
                ) : (
                  <p>{formData.name}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">API URL</label>
                {isEditing ? (
                  <input
                    type="text"
                    value={formData.apiUrl}
                    onChange={(e) => handleChange("apiUrl", e.target.value)}
                    className="w-full p-2 border rounded"
                  />
                ) : (
                  <p>{formData.apiUrl}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                {isEditing ? (
                  <input
                    type="password"
                    value={formData.apiKey}
                    onChange={(e) => handleChange("apiKey", e.target.value)}
                    className="w-full p-2 border rounded"
                  />
                ) : (
                  <p>••••••••••••</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                {isEditing ? (
                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={formData.isActive}
                      onChange={(e) => handleChange("isActive", e.target.checked)}
                      className="rounded"
                      id="provider-active"
                    />
                    <label htmlFor="provider-active" className="text-sm select-none">
                      Active
                    </label>
                  </div>
                ) : (
                  <p>
                    {formData.isActive ? (
                      <span className="text-green-600 font-medium">Active</span>
                    ) : (
                      <span className="text-gray-600">Inactive</span>
                    )}
                  </p>
                )}
              </div>

              <div className="flex space-x-2 pt-4">
                {isEditing ? (
                  <>
                    <button
                      onClick={handleSave}
                      className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                      disabled={isSaving}
                    >
                      {isSaving ? "Saving..." : "Save"}
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
                      className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
                      disabled={isTesting}
                    >
                      {isTesting ? "Testing..." : "Test Connection"}
                    </button>
                    <button
                      onClick={handleDelete}
                      className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors disabled:opacity-50"
                      disabled={isDeleting}
                    >
                      {isDeleting ? "Deleting..." : "Delete"}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {!selectedProvider && !isCreating && (
            <p className="text-gray-500">Select a provider to view details or create a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
};

export { FraudCheckerSettings };
