import { type FC, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  type FraudCheckerProviderPayload,
  createFraudCheckerProvider,
  updateFraudCheckerProvider,
  deleteFraudCheckerProvider,
  testFraudCheckerProvider,
} from "~/lib/api-functions/fraud-checker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ExternalLink, Loader2, Plus, Pencil, Trash2, TestTube } from "lucide-react";
import {
  FRAUD_CHECK_PROVIDER_TYPES,
  FRAUD_CHECK_PROVIDER_DEFINITIONS,
  getFraudCheckProviderDefinition,
} from "@scalius/core/modules/fraud-checker/provider";

import type { FraudCheckProviderType } from "@scalius/core/modules/fraud-checker/provider";

// ── Types & Validation ──

type FraudProvider = FraudCheckerProviderPayload;

const providerSchema = z.object({
  providerType: z.enum(FRAUD_CHECK_PROVIDER_TYPES),
  name: z.string().min(1, "Name is required"),
  apiUrl: z.string().min(1, "API URL is required"),
  apiKey: z.string().min(1, "API key is required"),
  apiSecret: z.string().optional(),
  userId: z.string().optional(),
  isActive: z.boolean(),
}).superRefine((values, ctx) => {
  const definition = getFraudCheckProviderDefinition(values.providerType);

  for (const field of definition.requiredFields) {
    const value = values[field];
    if (!value || value.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${definition[field === "apiKey" ? "apiKeyLabel" : field === "apiSecret" ? "apiSecretLabel" : "userIdLabel"] ?? field} is required`,
      });
    }
  }
});

type ProviderFormValues = z.infer<typeof providerSchema>;

interface FraudCheckerSettingsProps {
  providers: FraudCheckerProviderPayload[];
}

const DEFAULT_PROVIDER_TYPE: FraudCheckProviderType = "default";

function credentialPlaceholder(label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  return `Enter ${label.toLowerCase()}`;
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
      providerType: DEFAULT_PROVIDER_TYPE,
      name: "",
      apiUrl: getFraudCheckProviderDefinition(DEFAULT_PROVIDER_TYPE).defaultApiUrl,
      apiKey: "",
      apiSecret: "",
      userId: "",
      isActive: false,
    },
  });

  const providerType = form.watch("providerType") || DEFAULT_PROVIDER_TYPE;
  const providerDefinition = getFraudCheckProviderDefinition(providerType);
  const needsApiSecret = providerDefinition.requiredFields.includes("apiSecret");
  const needsUserId = providerDefinition.requiredFields.includes("userId");

  const resetForm = (provider?: FraudProvider) => {
    const definition = getFraudCheckProviderDefinition(provider?.providerType ?? DEFAULT_PROVIDER_TYPE);
    form.reset(
      provider
        ? {
            providerType: provider.providerType ?? DEFAULT_PROVIDER_TYPE,
            name: provider.name,
            apiUrl: provider.apiUrl || definition.defaultApiUrl,
            apiKey: provider.apiKey,
            apiSecret: provider.apiSecret ?? "",
            userId: provider.userId ?? "",
            isActive: provider.isActive,
          }
        : {
            providerType: DEFAULT_PROVIDER_TYPE,
            name: "",
            apiUrl: definition.defaultApiUrl,
            apiKey: "",
            apiSecret: "",
            userId: "",
            isActive: false,
          },
    );
  };

  const handleProviderTypeChange = (value: string) => {
    const nextDefinition = getFraudCheckProviderDefinition(value);
    const currentDefinition = getFraudCheckProviderDefinition(form.getValues("providerType"));
    const currentName = form.getValues("name");
    const currentUrl = form.getValues("apiUrl");
    const presetNames = FRAUD_CHECK_PROVIDER_DEFINITIONS.map((definition) => definition.label);

    form.setValue("providerType", nextDefinition.value, { shouldDirty: true });

    if (!currentName || presetNames.includes(currentName)) {
      form.setValue("name", nextDefinition.value === DEFAULT_PROVIDER_TYPE ? "" : nextDefinition.label, { shouldDirty: true });
    }

    if (!currentUrl || currentUrl === currentDefinition.defaultApiUrl) {
      form.setValue("apiUrl", nextDefinition.defaultApiUrl, { shouldDirty: true });
    }

    if (!nextDefinition.requiredFields.includes("apiSecret")) {
      form.setValue("apiSecret", "", { shouldDirty: true });
    }

    if (!nextDefinition.requiredFields.includes("userId")) {
      form.setValue("userId", "", { shouldDirty: true });
    }
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
        saved = await createFraudCheckerProvider({ data: values });
        setProviders((prev) => [...prev, saved]);
      } else if (selectedProvider) {
        saved = await updateFraudCheckerProvider({ data: { ...values, id: selectedProvider.id } });
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
      const result = await testFraudCheckerProvider({ data: { id: selectedProvider.id } });
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
                    <Badge variant="outline" className="hidden sm:inline-flex text-[10px] px-1.5 py-0">
                      {getFraudCheckProviderDefinition(provider.providerType).shortLabel}
                    </Badge>
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
                  <Label htmlFor="providerType" className="text-xs">Provider</Label>
                  <Select value={providerType} onValueChange={handleProviderTypeChange}>
                    <SelectTrigger id="providerType" className="h-8 text-sm">
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {FRAUD_CHECK_PROVIDER_DEFINITIONS.map((definition) => (
                        <SelectItem key={definition.value} value={definition.value}>
                          {definition.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{providerDefinition.helpText}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{providerDefinition.requestFormatHint}</span>
                    {providerDefinition.docsUrl && (
                      <a
                        href={providerDefinition.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Provider docs
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  {form.formState.errors.providerType && (
                    <p className="text-xs text-destructive">{form.formState.errors.providerType.message}</p>
                  )}
                </div>

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
                  <Label htmlFor="apiKey" className="text-xs">{providerDefinition.apiKeyLabel}</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    {...form.register("apiKey")}
                    className="h-8 text-sm"
                    placeholder={credentialPlaceholder(providerDefinition.apiKeyLabel, "Enter API key")}
                  />
                  {form.formState.errors.apiKey && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiKey.message}</p>
                  )}
                </div>

                {needsApiSecret && (
                  <div className="space-y-1.5">
                    <Label htmlFor="apiSecret" className="text-xs">{providerDefinition.apiSecretLabel}</Label>
                    <Input
                      id="apiSecret"
                      type="password"
                      {...form.register("apiSecret")}
                      className="h-8 text-sm"
                      placeholder={credentialPlaceholder(providerDefinition.apiSecretLabel, "Enter API secret")}
                    />
                    {form.formState.errors.apiSecret && (
                      <p className="text-xs text-destructive">{form.formState.errors.apiSecret.message}</p>
                    )}
                  </div>
                )}

                {needsUserId && (
                  <div className="space-y-1.5">
                    <Label htmlFor="userId" className="text-xs">{providerDefinition.userIdLabel}</Label>
                    <Input
                      id="userId"
                      {...form.register("userId")}
                      className="h-8 text-sm"
                      placeholder={credentialPlaceholder(providerDefinition.userIdLabel, "Enter user ID")}
                    />
                    {form.formState.errors.userId && (
                      <p className="text-xs text-destructive">{form.formState.errors.userId.message}</p>
                    )}
                  </div>
                )}

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
                  <Label className="text-xs">Provider</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {getFraudCheckProviderDefinition(selectedProvider.providerType).label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {getFraudCheckProviderDefinition(selectedProvider.providerType).helpText}
                    </span>
                    {getFraudCheckProviderDefinition(selectedProvider.providerType).docsUrl && (
                      <a
                        href={getFraudCheckProviderDefinition(selectedProvider.providerType).docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        Provider docs
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {getFraudCheckProviderDefinition(selectedProvider.providerType).requestFormatHint}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">Name</Label>
                  <p className="text-sm">{selectedProvider.name}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiUrl" className="text-xs">API URL</Label>
                  <p className="text-sm font-mono text-muted-foreground">{selectedProvider.apiUrl}</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{getFraudCheckProviderDefinition(selectedProvider.providerType).apiKeyLabel}</Label>
                  <p className="text-sm text-muted-foreground">{"*".repeat(12)}</p>
                </div>

                {getFraudCheckProviderDefinition(selectedProvider.providerType).requiredFields.includes("apiSecret") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {getFraudCheckProviderDefinition(selectedProvider.providerType).apiSecretLabel}
                    </Label>
                    <p className="text-sm text-muted-foreground">{"*".repeat(12)}</p>
                  </div>
                )}

                {getFraudCheckProviderDefinition(selectedProvider.providerType).requiredFields.includes("userId") && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {getFraudCheckProviderDefinition(selectedProvider.providerType).userIdLabel}
                    </Label>
                    <p className="text-sm text-muted-foreground">{selectedProvider.userId || "Not configured"}</p>
                  </div>
                )}

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
