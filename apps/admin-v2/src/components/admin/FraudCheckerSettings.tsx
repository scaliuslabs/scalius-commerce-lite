import { type FC, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  createFraudCheckerProvider,
  updateFraudCheckerProvider,
  deleteFraudCheckerProvider,
  testFraudCheckerProvider,
} from "~/lib/api.functions";
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
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Plus, Pencil, Trash2, TestTube } from "lucide-react";

import type { FraudCheckerProvider } from "@/types/api-responses";

// ── Types & Validation ──

type FraudProvider = FraudCheckerProvider;

const providerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  apiUrl: z.string().min(1, "API URL is required"),
  apiKey: z.string().min(1, "API key is required"),
  isActive: z.boolean(),
});

type ProviderFormValues = z.infer<typeof providerSchema>;

interface FraudCheckerSettingsProps {
  providers: FraudCheckerProvider[];
}

// ── Component ──

const FraudCheckerSettings: FC<FraudCheckerSettingsProps> = ({
  providers: initialProviders,
}) => {
  const [providers, setProviders] = useState<FraudProvider[]>(initialProviders);
  const [selectedProvider, setSelectedProvider] = useState<FraudProvider | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FraudProvider | null>(null);

  const form = useForm<ProviderFormValues>({
    resolver: zodResolver(providerSchema),
    defaultValues: {
      name: "",
      apiUrl: "https://fraudchecker.link/api/v1/qc/",
      apiKey: "",
      isActive: false,
    },
  });

  const resetForm = (provider?: FraudProvider) => {
    form.reset(
      provider
        ? { name: provider.name, apiUrl: provider.apiUrl, apiKey: provider.apiKey, isActive: provider.isActive }
        : { name: "", apiUrl: "https://fraudchecker.link/api/v1/qc/", apiKey: "", isActive: false },
    );
  };

  const handleSelect = (provider: FraudProvider) => {
    setSelectedProvider(provider);
    resetForm(provider);
    setIsEditing(false);
    setIsCreating(false);
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

  const handleSave = async (values: ProviderFormValues) => {
    if (!isEditing || (!isCreating && !selectedProvider)) return;

    setIsSaving(true);
    try {
      let saved: FraudProvider;
      if (isCreating) {
        saved = await createFraudCheckerProvider({ data: values }) as FraudProvider;
        setProviders((prev) => [...prev, saved]);
      } else if (selectedProvider) {
        saved = await updateFraudCheckerProvider({ data: { ...values, id: selectedProvider.id } }) as FraudProvider;
        setProviders((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
      } else {
        return;
      }

      setSelectedProvider(saved);
      resetForm(saved);
      setIsEditing(false);
      setIsCreating(false);
      toast.success("Provider saved successfully");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to save provider");
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteFraudCheckerProvider({ data: { id: deleteTarget.id } });
      setProviders((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      if (selectedProvider?.id === deleteTarget.id) {
        setSelectedProvider(null);
        setIsEditing(false);
      }
      toast.success("Provider deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete provider");
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleTest = async () => {
    if (!selectedProvider) return;
    setIsTesting(true);
    try {
      const result = await testFraudCheckerProvider({ data: { id: selectedProvider.id } }) as { success: boolean; message?: string };
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to test provider");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Provider List */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Providers</CardTitle>
              <Button type="button" variant="outline" size="sm" onClick={handleCreate} className="h-7 text-xs">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No providers configured</p>
            ) : (
              <ul className="space-y-1.5">
                {providers.map((provider) => (
                  <li
                    key={provider.id}
                    className={`flex items-center gap-2 p-2 rounded-md cursor-pointer text-sm transition-colors ${
                      selectedProvider?.id === provider.id
                        ? "bg-accent border border-border"
                        : "hover:bg-accent/50 border border-transparent"
                    }`}
                    onClick={() => handleSelect(provider)}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        provider.isActive ? "bg-green-500" : "bg-muted-foreground/30"
                      }`}
                    />
                    <span className="font-medium truncate">{provider.name}</span>
                    <Badge variant={provider.isActive ? "default" : "secondary"} className="ml-auto text-[10px] px-1.5 py-0">
                      {provider.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Provider Detail / Form */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">
              {isCreating ? "New Provider" : selectedProvider ? "Provider Details" : "Select a Provider"}
            </CardTitle>
            {!isCreating && !selectedProvider && (
              <CardDescription className="text-xs">
                Select a provider to view details, or add a new one.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {(selectedProvider || isCreating) && isEditing ? (
              <form onSubmit={form.handleSubmit(handleSave)} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">Name</Label>
                  <Input
                    id="name"
                    {...form.register("name")}
                    className="h-8 text-sm"
                    placeholder="Provider name"
                  />
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiUrl" className="text-xs">API URL</Label>
                  <Input
                    id="apiUrl"
                    {...form.register("apiUrl")}
                    className="h-8 text-sm"
                    placeholder="https://fraudchecker.link/api/v1/qc/"
                  />
                  {form.formState.errors.apiUrl && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiUrl.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiKey" className="text-xs">API Key</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    {...form.register("apiKey")}
                    className="h-8 text-sm"
                    placeholder="Enter API key"
                  />
                  {form.formState.errors.apiKey && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiKey.message}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="isActive"
                    checked={form.watch("isActive")}
                    onCheckedChange={(checked) => form.setValue("isActive", checked)}
                  />
                  <Label htmlFor="isActive" className="text-xs cursor-pointer">
                    {form.watch("isActive") ? "Active" : "Inactive"}
                  </Label>
                </div>

                <div className="flex gap-2 pt-2 border-t">
                  <Button type="submit" size="sm" disabled={isSaving} className="h-7 text-xs">
                    {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                    Save
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleCancel} className="h-7 text-xs">
                    Cancel
                  </Button>
                </div>
              </form>
            ) : selectedProvider ? (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">Name</Label>
                  <p className="text-sm">{selectedProvider.name}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiUrl" className="text-xs">API URL</Label>
                  <p className="text-sm font-mono text-muted-foreground">{selectedProvider.apiUrl}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiKey" className="text-xs">API Key</Label>
                  <p className="text-sm text-muted-foreground">{"*".repeat(12)}</p>
                </div>

                <div className="flex items-center gap-2">
                  <Switch
                    id="isActive"
                    checked={selectedProvider.isActive}
                    disabled
                  />
                  <Label htmlFor="isActive" className="text-xs">
                    {selectedProvider.isActive ? "Active" : "Inactive"}
                  </Label>
                </div>

                <div className="flex gap-2 pt-2 border-t">
                  <Button type="button" variant="outline" size="sm" onClick={handleEdit} className="h-7 text-xs">
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={isTesting} className="h-7 text-xs">
                    {isTesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <TestTube className="h-3.5 w-3.5 mr-1" />}
                    Test
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteTarget(selectedProvider)}
                    className="h-7 text-xs"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export { FraudCheckerSettings };
