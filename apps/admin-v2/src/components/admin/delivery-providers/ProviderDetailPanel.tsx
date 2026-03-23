import { Link } from "@tanstack/react-router";
import {
  Loader2,
  Pencil,
  Trash2,
  TestTube,
  Save,
  X,
  Truck,
  Copy,
  Check,
  Webhook,
  Info,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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
} from "~/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import {
  ProviderIcon,
  PROVIDER_VISUAL,
  PROVIDER_TYPES,
  type DeliveryProviderRecord,
  type DeliveryProviderType,
} from "./ProviderIcon";

interface ProviderDetailPanelProps {
  selectedProvider: DeliveryProviderRecord | null;
  isEditing: boolean;
  isCreating: boolean;
  isTesting: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  isTestingCredentials: boolean;
  copiedWebhookUrl: boolean;
  copiedSecret: boolean;
  formData: Omit<DeliveryProviderRecord, "createdAt" | "updatedAt">;
  creds: Record<string, string>;
  conf: Record<string, string | number>;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  onSave: () => void;
  onTestCredentials: () => void;
  onCancel: () => void;
  onChangeField: (field: string, value: string | boolean) => void;
  onChangeType: (type: DeliveryProviderType) => void;
  onChangeCredential: (field: string, value: string) => void;
  onChangeConfig: (field: string, value: string | number) => void;
  getWebhookUrl: (type: string) => string;
  onCopyWebhookUrl: () => void;
  onCopySecret: () => void;
  onGenerateSecret: () => void;
}

export function ProviderDetailPanel({
  selectedProvider,
  isEditing,
  isCreating,
  isTesting,
  isSaving,
  isDeleting,
  isTestingCredentials,
  copiedWebhookUrl,
  copiedSecret,
  formData,
  creds,
  conf,
  onEdit,
  onTest,
  onDelete,
  onSave,
  onTestCredentials,
  onCancel,
  onChangeField,
  onChangeType,
  onChangeCredential,
  onChangeConfig,
  getWebhookUrl,
  onCopyWebhookUrl,
  onCopySecret,
  onGenerateSecret,
}: ProviderDetailPanelProps) {
  if (!selectedProvider && !isCreating) {
    return (
      <Card className="md:col-span-2">
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Truck className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm">
            Select a provider or add a new one to get started.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="md:col-span-2">
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
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onTest}
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
                    onClick={onDelete}
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
                onChange={(e) => onChangeField("name", e.target.value)}
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
                    onChangeType(val as DeliveryProviderType)
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
                  onChangeField("isActive", checked)
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
                  onChange={(e) => onChangeCredential("baseUrl", e.target.value)}
                  disabled={!isEditing}
                  placeholder="https://api-hermes.pathao.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Client ID</Label>
                <Input
                  value={creds.clientId || ""}
                  onChange={(e) => onChangeCredential("clientId", e.target.value)}
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Client Secret</Label>
                <Input
                  type="password"
                  value={creds.clientSecret || ""}
                  onChange={(e) => onChangeCredential("clientSecret", e.target.value)}
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input
                  value={creds.username || ""}
                  onChange={(e) => onChangeCredential("username", e.target.value)}
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Password</Label>
                <Input
                  type="password"
                  value={creds.password || ""}
                  onChange={(e) => onChangeCredential("password", e.target.value)}
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
                  onChange={(e) => onChangeCredential("baseUrl", e.target.value)}
                  disabled={!isEditing}
                  placeholder="https://portal.steadfast.com.bd/api/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={creds.apiKey || ""}
                  onChange={(e) => onChangeCredential("apiKey", e.target.value)}
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Secret Key</Label>
                <Input
                  type="password"
                  value={creds.secretKey || ""}
                  onChange={(e) => onChangeCredential("secretKey", e.target.value)}
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
                  onChange={(e) => onChangeConfig("storeId", e.target.value)}
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Default Delivery Type</Label>
                {isEditing ? (
                  <Select
                    value={String(conf.defaultDeliveryType || 48)}
                    onValueChange={(val) =>
                      onChangeConfig("defaultDeliveryType", Number(val))
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
                      onChangeConfig("defaultItemType", Number(val))
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
                    onChangeConfig("defaultItemWeight", Number(e.target.value))
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
                    onChangeConfig("defaultCodAmount", Number(e.target.value))
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
                  onClick={onCopyWebhookUrl}
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
                  onClick={onCopySecret}
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
                  onClick={onGenerateSecret}
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
              onClick={onSave}
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
              onClick={onTestCredentials}
              disabled={isTestingCredentials}
            >
              {isTestingCredentials ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <TestTube className="h-4 w-4 mr-1" />
              )}
              Test Credentials
            </Button>
            <Button variant="ghost" onClick={onCancel}>
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
                      <li><strong className="text-foreground">Locations Mapping (CRITICAL):</strong> Pathao requires precise numeric IDs for City, Zone, and Area. If you do not configure these in the <Link to="/admin/settings/delivery-providers" className="text-primary hover:underline">Delivery Locations</Link> page (in the <em>External IDs</em> JSON field mapping such as <code>{`{"pathao": 123}`}</code>), shipments will fail to create.</li>
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
    </Card>
  );
}
