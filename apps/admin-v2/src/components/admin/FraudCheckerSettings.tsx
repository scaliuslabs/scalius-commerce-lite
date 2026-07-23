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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  Pencil,
  ShieldCheck,
  Trash2,
  TestTube,
} from "lucide-react";
import {
  FRAUD_CHECK_PROVIDER_TYPES,
  FRAUD_CHECK_PROVIDER_DEFINITIONS,
  getFraudCheckProviderDefinition,
} from "@scalius/core/modules/fraud-checker/provider";

import type { FraudCheckProviderType } from "@scalius/core/modules/fraud-checker/provider";
import {
  OfficialProviderMark,
} from "~/components/admin/settings/provider-marks";
import { getFraudProviderMarkId } from "./fraud-provider-presentation";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

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

interface ProviderTestState {
  status: "passed" | "failed";
  message: string;
}

const DEFAULT_PROVIDER_TYPE: FraudCheckProviderType = "default";

function FraudProviderMark({
  providerType,
  size = "sm",
}: {
  providerType: FraudCheckProviderType | undefined;
  size?: "sm" | "md";
}) {
  const provider = getFraudProviderMarkId(providerType);
  if (provider) return <OfficialProviderMark provider={provider} size={size} />;
  return (
    <span
      className={size === "sm" ? "inline-flex h-6 w-6 items-center justify-center" : "inline-flex h-8 w-8 items-center justify-center"}
      aria-hidden="true"
    >
      <ShieldCheck className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} />
    </span>
  );
}

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
  const [testStates, setTestStates] = useState<Record<string, ProviderTestState>>({});
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission(ADMIN_PERMISSIONS.SETTINGS_FRAUD_CHECKER_EDIT);

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
    if (!canEdit) return;
    resetForm();
    setIsCreating(true);
    setIsEditing(true);
    setSelectedProvider(null);
  };

  const handleEdit = () => {
    if (!selectedProvider || !canEdit) return;
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
      setTestStates((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
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
      setTestStates((current) => ({
        ...current,
        [selectedProvider.id]: {
          status: result.success ? "passed" : "failed",
          message:
            result.message ||
            (result.success ? "Connection succeeded." : "Connection failed."),
        },
      }));
      if (result.success) {
        toast.success(result.message || "Connection successful");
      } else {
        toast.error(result.message || "Connection failed");
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to test provider";
      setTestStates((current) => ({
        ...current,
        [selectedProvider.id]: { status: "failed", message },
      }));
      toast.error(message);
    } finally {
      setIsTesting(false);
    }
  };

  const selectedDefinition = selectedProvider
    ? getFraudCheckProviderDefinition(selectedProvider.providerType)
    : null;
  const selectedTestState = selectedProvider
    ? testStates[selectedProvider.id]
    : undefined;

  return (
    <div className="space-y-4">
      <UnsavedChangesGuard
        isDirty={isEditing && form.formState.isDirty}
        isSubmitting={isSaving}
      />

      {!canEdit && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Read-only access</AlertTitle>
          <AlertDescription>
            You can inspect providers and test saved connections, but you cannot
            change their configuration.
          </AlertDescription>
        </Alert>
      )}

      {providers.length === 0 && !isCreating ? (
        <Card className="shadow-none">
          <CardContent className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-muted">
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="mt-3 text-base font-semibold">No fraud provider</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {canEdit
                ? "Add a provider to check customer risk from an order."
                : "No provider is available for order risk checks."}{" "}
              Checks are manual and never block checkout.
            </p>
            {canEdit && (
              <Button
                type="button"
                className="mt-4 min-h-11 gap-1.5 sm:min-h-9"
                onClick={handleCreate}
              >
                <Plus className="h-4 w-4" />
                Add provider
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div
          className={
            providers.length === 0
              ? "mx-auto w-full max-w-2xl"
              : "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,2fr)]"
          }
        >
          {providers.length > 0 && (
            <Card className="shadow-none">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Providers</CardTitle>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleCreate}
                      disabled={isEditing}
                      className="min-h-11 gap-1.5 text-xs sm:min-h-8"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="space-y-1.5">
                  {providers.map((provider) => (
                    <li key={provider.id}>
                      <button
                        type="button"
                        className={`flex min-h-11 w-full items-center gap-2 rounded-md border p-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          selectedProvider?.id === provider.id
                            ? "border-border bg-accent"
                            : "border-transparent hover:bg-accent/50"
                        }`}
                        aria-pressed={selectedProvider?.id === provider.id}
                        disabled={isEditing}
                        onClick={() => handleSelect(provider)}
                      >
                        <FraudProviderMark providerType={provider.providerType} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{provider.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {getFraudCheckProviderDefinition(provider.providerType).shortLabel}
                          </span>
                        </span>
                        <Badge
                          variant={provider.isActive ? "default" : "secondary"}
                          className="shrink-0 text-[10px]"
                        >
                          {provider.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card className="min-w-0 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {(selectedProvider || isCreating) ? (
                <FraudProviderMark
                  providerType={isCreating ? providerType : selectedProvider?.providerType}
                  size="md"
                />
              ) : null}
              {isCreating ? "New provider" : selectedProvider ? selectedProvider.name : "Select a provider"}
            </CardTitle>
            {!isCreating && !selectedProvider && (
              <CardDescription className="text-xs">
                Choose a provider to review setup, usage, and connection state.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {(selectedProvider || isCreating) && isEditing ? (
              <form
                method="post"
                onSubmit={form.handleSubmit(handleSave)}
                className="space-y-4"
                noValidate
              >
                <div className="space-y-1.5">
                  <Label htmlFor="providerType">Provider type</Label>
                  <Select value={providerType} onValueChange={handleProviderTypeChange}>
                    <SelectTrigger id="providerType" className="min-h-11 text-sm sm:min-h-8">
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {FRAUD_CHECK_PROVIDER_DEFINITIONS.map((definition) => (
                        <SelectItem key={definition.value} value={definition.value}>
                          <span className="flex items-center gap-2">
                            <FraudProviderMark providerType={definition.value} />
                            {definition.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{providerDefinition.helpText}</p>
                  {form.formState.errors.providerType && (
                    <p className="text-xs text-destructive">{form.formState.errors.providerType.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="name">Internal name</Label>
                  <Input
                    id="name"
                    {...form.register("name")}
                    className="min-h-11 text-sm sm:min-h-8"
                    placeholder="For example, FraudBD production"
                  />
                  {form.formState.errors.name && (
                    <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiUrl">API URL</Label>
                  <Input
                    id="apiUrl"
                    {...form.register("apiUrl")}
                    className="min-h-11 text-sm sm:min-h-8"
                    placeholder="https://fraudchecker.link/api/v1/qc/"
                  />
                  {form.formState.errors.apiUrl && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiUrl.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="apiKey">{providerDefinition.apiKeyLabel}</Label>
                  <Input
                    id="apiKey"
                    type="password"
                    {...form.register("apiKey")}
                    className="min-h-11 text-sm sm:min-h-8"
                    placeholder={credentialPlaceholder(providerDefinition.apiKeyLabel, "Enter API key")}
                  />
                  {form.formState.errors.apiKey && (
                    <p className="text-xs text-destructive">{form.formState.errors.apiKey.message}</p>
                  )}
                </div>

                {needsApiSecret && (
                  <div className="space-y-1.5">
                    <Label htmlFor="apiSecret">{providerDefinition.apiSecretLabel}</Label>
                    <Input
                      id="apiSecret"
                      type="password"
                      {...form.register("apiSecret")}
                      className="min-h-11 text-sm sm:min-h-8"
                      placeholder={credentialPlaceholder(providerDefinition.apiSecretLabel, "Enter API secret")}
                    />
                    {form.formState.errors.apiSecret && (
                      <p className="text-xs text-destructive">{form.formState.errors.apiSecret.message}</p>
                    )}
                  </div>
                )}

                {needsUserId && (
                  <div className="space-y-1.5">
                    <Label htmlFor="userId">{providerDefinition.userIdLabel}</Label>
                    <Input
                      id="userId"
                      {...form.register("userId")}
                      className="min-h-11 text-sm sm:min-h-8"
                      placeholder={credentialPlaceholder(providerDefinition.userIdLabel, "Enter user ID")}
                    />
                    {form.formState.errors.userId && (
                      <p className="text-xs text-destructive">{form.formState.errors.userId.message}</p>
                    )}
                  </div>
                )}

                <div className="rounded-md border px-3 py-2.5">
                  <div className="flex min-h-11 items-center justify-between gap-3">
                    <div>
                      <Label htmlFor="isActive" className="cursor-pointer text-sm font-medium">
                        Available in Orders
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Manual check only; checkout remains unaffected.
                      </p>
                    </div>
                    <Switch
                      id="isActive"
                      checked={form.watch("isActive")}
                      onCheckedChange={(checked) =>
                        form.setValue("isActive", checked, { shouldDirty: true })
                      }
                    />
                  </div>
                </div>

                <details className="rounded-md border px-3 py-2 text-sm">
                  <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-8">
                    Technical details
                  </summary>
                  <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-2 text-xs text-muted-foreground">
                    <span>{providerDefinition.requestFormatHint}</span>
                    {providerDefinition.docsUrl && (
                      <a
                        href={providerDefinition.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-11 items-center gap-1 text-primary hover:underline sm:min-h-8"
                      >
                        Provider docs
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </details>

                <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={isSaving || !form.formState.isDirty}
                    className="min-h-11 sm:min-h-8"
                  >
                    {isSaving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    Save provider
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={handleCancel} className="min-h-11 sm:min-h-8">
                    Cancel
                  </Button>
                  {form.formState.isDirty && (
                    <span className="self-center text-xs text-muted-foreground" aria-live="polite">
                      Unsaved changes
                    </span>
                  )}
                </div>
              </form>
            ) : selectedProvider ? (
              <div className="space-y-4">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-md border bg-muted/20 px-3 py-2">
                    <dt className="text-xs text-muted-foreground">Setup</dt>
                    <dd className="mt-1 text-sm font-medium">Credentials saved</dd>
                  </div>
                  <div className="rounded-md border bg-muted/20 px-3 py-2">
                    <dt className="text-xs text-muted-foreground">Used in Orders</dt>
                    <dd className="mt-1 text-sm font-medium">
                      {selectedProvider.isActive ? "Active" : "Inactive"}
                    </dd>
                  </div>
                  <div className="rounded-md border bg-muted/20 px-3 py-2">
                    <dt className="text-xs text-muted-foreground">Connection</dt>
                    <dd className="mt-1 text-sm font-medium">
                      {selectedTestState?.status === "passed"
                        ? "Passed this session"
                        : selectedTestState?.status === "failed"
                          ? "Failed this session"
                          : "Not checked this session"}
                    </dd>
                  </div>
                </dl>

                <div>
                  <Badge variant="outline">{selectedDefinition?.label}</Badge>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {selectedDefinition?.helpText}
                  </p>
                </div>

                {selectedTestState && (
                  <Alert variant={selectedTestState.status === "failed" ? "destructive" : "default"}>
                    {selectedTestState.status === "passed" ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    <AlertTitle>
                      {selectedTestState.status === "passed" ? "Connection passed" : "Connection failed"}
                    </AlertTitle>
                    <AlertDescription>{selectedTestState.message}</AlertDescription>
                  </Alert>
                )}

                <details className="rounded-md border px-3 py-2 text-sm">
                  <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-8">
                    Technical details
                  </summary>
                  <dl className="mt-2 space-y-2 border-t pt-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">API URL</dt>
                      <dd className="break-all font-mono">{selectedProvider.apiUrl}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Credentials</dt>
                      <dd>Stored securely</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Request</dt>
                      <dd>{selectedDefinition?.requestFormatHint}</dd>
                    </div>
                  </dl>
                  {selectedDefinition?.docsUrl && (
                    <a
                      href={selectedDefinition.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs text-primary hover:underline sm:min-h-8"
                    >
                      Provider docs
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </details>

                <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:flex-wrap">
                  {canEdit && (
                    <Button type="button" variant="outline" size="sm" onClick={handleEdit} className="min-h-11 sm:min-h-8">
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  )}
                  <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={isTesting} className="min-h-11 sm:min-h-8">
                    {isTesting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <TestTube className="mr-1 h-3.5 w-3.5" />}
                    Test connection
                  </Button>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteTarget(selectedProvider)}
                      className="min-h-11 sm:min-h-8"
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Delete
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Testing sends one provider lookup with the platform test number. Results are shown for this browser session only.
                </p>
              </div>
            ) : null}
          </CardContent>
          </Card>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete provider?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.name}” will no longer be available for order risk checks. This cannot be undone.
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
