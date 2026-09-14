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
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MoreHorizontal,
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
import {
  ContextualSaveBar,
  EmptyState,
  FieldError,
  IndexTable,
  InlineHelp,
  SettingsSection,
  StatusBadge,
  type IndexTableColumn,
  type StatusTone,
} from "~/components/admin/shell";
import { getFraudProviderMarkId } from "./fraud-provider-presentation";
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

/** Connection evidence is per browser session, so the label always says so. */
function connectionLabel(state: ProviderTestState | undefined): string {
  if (state?.status === "passed") return "Passed this session";
  if (state?.status === "failed") return "Failed this session";
  return "Not checked this session";
}

function connectionTone(state: ProviderTestState | undefined): StatusTone {
  if (state?.status === "passed") return "success";
  if (state?.status === "failed") return "critical";
  return "neutral";
}

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

  const handleEdit = (provider: FraudProvider) => {
    if (!canEdit) return;
    setSelectedProvider(provider);
    resetForm(provider);
    setIsEditing(true);
    setIsCreating(false);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setIsCreating(false);
    if (selectedProvider) resetForm(selectedProvider);
  };

  /** Restores the last saved values without leaving the editor. */
  const handleDiscardDraft = () => {
    resetForm(isCreating ? undefined : (selectedProvider ?? undefined));
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

  const handleTest = async (provider: FraudProvider) => {
    setSelectedProvider(provider);
    setIsTesting(true);
    try {
      const result = await testFraudCheckerProvider({ data: { id: provider.id } });
      setTestStates((current) => ({
        ...current,
        [provider.id]: {
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
        [provider.id]: { status: "failed", message },
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
  const isDraftDirty = isEditing && form.formState.isDirty;

  const providerColumns: IndexTableColumn<FraudProvider>[] = [
    {
      id: "provider",
      header: "Provider",
      cell: (provider) => (
        <span
          className="flex min-w-0 items-center gap-2"
          aria-current={selectedProvider?.id === provider.id ? "true" : undefined}
        >
          <FraudProviderMark providerType={provider.providerType} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{provider.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {getFraudCheckProviderDefinition(provider.providerType).shortLabel}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "availability",
      header: "Used in Orders",
      mobileLabel: "Used in Orders",
      cell: (provider) => (
        <StatusBadge
          tone={provider.isActive ? "success" : "neutral"}
          srLabel="Used in Orders:"
        >
          {provider.isActive ? "Active" : "Inactive"}
        </StatusBadge>
      ),
    },
    {
      id: "connection",
      header: "Connection",
      mobileLabel: "Connection",
      cell: (provider) => (
        <StatusBadge
          tone={connectionTone(testStates[provider.id])}
          srLabel="Connection:"
        >
          {connectionLabel(testStates[provider.id])}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div>
      <ContextualSaveBar
        isDirty={isDraftDirty || isSaving}
        saving={isSaving}
        canSave={canEdit}
        saveLabel="Save provider"
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={handleDiscardDraft}
        onSave={() => void form.handleSubmit(handleSave)()}
      />

      <div className="space-y-6">
        {!canEdit && (
          <Alert>
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertTitle>Read-only access</AlertTitle>
            <AlertDescription>
              You can inspect providers and test saved connections, but you cannot
              change their configuration.
            </AlertDescription>
          </Alert>
        )}

        {providers.length === 0 && !isCreating ? (
          <EmptyState
            icon={ShieldCheck}
            heading="No fraud provider"
            body={`${canEdit
              ? "Add a provider to check customer risk from an order."
              : "No provider is available for order risk checks."} Checks are manual and never block checkout.`}
            action={
              canEdit
                ? { label: "Add provider", icon: Plus, onClick: handleCreate }
                : undefined
            }
          />
        ) : null}

        {providers.length > 0 ? (
          <section aria-labelledby="fraud-providers-heading" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="fraud-providers-heading" className="text-sm font-semibold leading-5">
                Providers
              </h2>
              {canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCreate}
                  disabled={isEditing}
                  className="min-h-11 gap-1.5 sm:min-h-9"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Add provider
                </Button>
              )}
            </div>
            <IndexTable
              items={providers}
              columns={providerColumns}
              getRowId={(provider) => provider.id}
              label="Fraud check providers"
              // While an editor is open the list stays read-only so a draft
              // cannot be lost by opening another provider.
              onRowClick={isEditing ? undefined : handleSelect}
              rowActions={(provider) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 sm:h-9 sm:w-9"
                      disabled={isEditing}
                      aria-label={`Actions for ${provider.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleSelect(provider)}>
                      Review setup
                    </DropdownMenuItem>
                    {canEdit && (
                      <DropdownMenuItem onClick={() => handleEdit(provider)}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={isTesting}
                      onClick={() => void handleTest(provider)}
                    >
                      <TestTube className="h-3.5 w-3.5" aria-hidden="true" />
                      Test connection
                    </DropdownMenuItem>
                    {canEdit && (
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteTarget(provider)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            />
            <InlineHelp>
              Risk lookup services a merchant can run by hand from an order.
              Checks are manual and never block checkout.
            </InlineHelp>
          </section>
        ) : null}

        {(selectedProvider || isCreating) && isEditing ? (
          <SettingsSection
            title={isCreating ? "New provider" : "Edit provider"}
            description="Credentials are stored encrypted and used only for manual order lookups."
            actions={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                className="min-h-11 sm:min-h-9"
              >
                Cancel
              </Button>
            }
          >
            <form
              method="post"
              onSubmit={form.handleSubmit(handleSave)}
              className="space-y-4"
              noValidate
            >
              <div className="space-y-1.5">
                <Label htmlFor="providerType">Provider type</Label>
                <Select value={providerType} onValueChange={handleProviderTypeChange}>
                  <SelectTrigger
                    id="providerType"
                    aria-describedby="providerType-help"
                    aria-invalid={Boolean(form.formState.errors.providerType)}
                    className="min-h-11 text-sm sm:min-h-9"
                  >
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
                {form.formState.errors.providerType ? (
                  <FieldError id="providerType-help">
                    {form.formState.errors.providerType.message}
                  </FieldError>
                ) : (
                  <InlineHelp id="providerType-help">
                    {providerDefinition.helpText}
                  </InlineHelp>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="name">Internal name</Label>
                <Input
                  id="name"
                  {...form.register("name")}
                  aria-describedby="name-help"
                  aria-invalid={Boolean(form.formState.errors.name)}
                  className="min-h-11 text-sm sm:min-h-9"
                  placeholder="For example, FraudBD production"
                />
                {form.formState.errors.name ? (
                  <FieldError id="name-help">
                    {form.formState.errors.name.message}
                  </FieldError>
                ) : (
                  <InlineHelp id="name-help">
                    Shown in the provider list and on the order risk check.
                  </InlineHelp>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apiUrl">API URL</Label>
                <Input
                  id="apiUrl"
                  {...form.register("apiUrl")}
                  aria-describedby="apiUrl-help"
                  aria-invalid={Boolean(form.formState.errors.apiUrl)}
                  className="min-h-11 text-sm sm:min-h-9"
                  placeholder="https://fraudchecker.link/api/v1/qc/"
                />
                {form.formState.errors.apiUrl ? (
                  <FieldError id="apiUrl-help">
                    {form.formState.errors.apiUrl.message}
                  </FieldError>
                ) : (
                  <InlineHelp id="apiUrl-help">
                    Endpoint the lookup request is sent to.
                  </InlineHelp>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="apiKey">{providerDefinition.apiKeyLabel}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  {...form.register("apiKey")}
                  aria-describedby="apiKey-help"
                  aria-invalid={Boolean(form.formState.errors.apiKey)}
                  className="min-h-11 text-sm sm:min-h-9"
                  placeholder={credentialPlaceholder(providerDefinition.apiKeyLabel, "Enter API key")}
                />
                <FieldError id="apiKey-help">
                  {form.formState.errors.apiKey?.message}
                </FieldError>
              </div>

              {needsApiSecret && (
                <div className="space-y-1.5">
                  <Label htmlFor="apiSecret">{providerDefinition.apiSecretLabel}</Label>
                  <Input
                    id="apiSecret"
                    type="password"
                    {...form.register("apiSecret")}
                    aria-describedby="apiSecret-help"
                    aria-invalid={Boolean(form.formState.errors.apiSecret)}
                    className="min-h-11 text-sm sm:min-h-9"
                    placeholder={credentialPlaceholder(providerDefinition.apiSecretLabel, "Enter API secret")}
                  />
                  <FieldError id="apiSecret-help">
                    {form.formState.errors.apiSecret?.message}
                  </FieldError>
                </div>
              )}

              {needsUserId && (
                <div className="space-y-1.5">
                  <Label htmlFor="userId">{providerDefinition.userIdLabel}</Label>
                  <Input
                    id="userId"
                    {...form.register("userId")}
                    aria-describedby="userId-help"
                    aria-invalid={Boolean(form.formState.errors.userId)}
                    className="min-h-11 text-sm sm:min-h-9"
                    placeholder={credentialPlaceholder(providerDefinition.userIdLabel, "Enter user ID")}
                  />
                  <FieldError id="userId-help">
                    {form.formState.errors.userId?.message}
                  </FieldError>
                </div>
              )}

              <div className="rounded-md border px-3 py-2.5">
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <div>
                    <Label htmlFor="isActive" className="cursor-pointer text-sm font-medium">
                      Available in Orders
                    </Label>
                    <InlineHelp>
                      Manual check only; checkout remains unaffected.
                    </InlineHelp>
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
                <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-9">
                  Technical details
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-3 border-t pt-2 text-xs text-muted-foreground">
                  <span>{providerDefinition.requestFormatHint}</span>
                  {providerDefinition.docsUrl && (
                    <a
                      href={providerDefinition.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center gap-1 text-primary hover:underline sm:min-h-9"
                    >
                      Provider docs
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </details>
            </form>
          </SettingsSection>
        ) : selectedProvider ? (
          <SettingsSection
            title={selectedProvider.name}
            description={selectedDefinition?.helpText}
            footer="Testing sends one provider lookup with the platform test number. Results are shown for this browser session only."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleEdit(selectedProvider)}
                    className="min-h-11 sm:min-h-9"
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    Edit
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTest(selectedProvider)}
                  disabled={isTesting}
                  className="min-h-11 sm:min-h-9"
                >
                  {isTesting ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <TestTube className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Test connection
                </Button>
                {canEdit && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setDeleteTarget(selectedProvider)}
                    className="min-h-11 sm:min-h-9"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </Button>
                )}
              </div>
            }
          >
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <FraudProviderMark
                  providerType={selectedProvider.providerType}
                  size="md"
                />
                <StatusBadge tone="info" dot={false}>
                  {selectedDefinition?.label}
                </StatusBadge>
              </div>

              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-md border bg-muted/20 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Setup</dt>
                  <dd className="mt-1 text-sm font-medium">Credentials saved</dd>
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Used in Orders</dt>
                  <dd className="mt-1">
                    <StatusBadge tone={selectedProvider.isActive ? "success" : "neutral"}>
                      {selectedProvider.isActive ? "Active" : "Inactive"}
                    </StatusBadge>
                  </dd>
                </div>
                <div className="rounded-md border bg-muted/20 px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Connection</dt>
                  <dd className="mt-1">
                    <StatusBadge tone={connectionTone(selectedTestState)}>
                      {connectionLabel(selectedTestState)}
                    </StatusBadge>
                  </dd>
                </div>
              </dl>

              {selectedTestState && (
                <Alert variant={selectedTestState.status === "failed" ? "destructive" : "default"}>
                  {selectedTestState.status === "passed" ? (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  )}
                  <AlertTitle>
                    {selectedTestState.status === "passed" ? "Connection passed" : "Connection failed"}
                  </AlertTitle>
                  <AlertDescription>{selectedTestState.message}</AlertDescription>
                </Alert>
              )}

              <details className="rounded-md border px-3 py-2 text-sm">
                <summary className="flex min-h-11 cursor-pointer items-center font-medium sm:min-h-9">
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
                    className="mt-2 inline-flex min-h-11 items-center gap-1 text-xs text-primary hover:underline sm:min-h-9"
                  >
                    Provider docs
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                )}
              </details>
            </div>
          </SettingsSection>
        ) : null}
      </div>

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
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export { FraudCheckerSettings };
