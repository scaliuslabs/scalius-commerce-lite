import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getBusinessSettings,
  type SettingsPayload,
  updateBusinessSettings,
} from "@/lib/api-functions/settings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { UnsavedChangesGuard } from "../shared/UnsavedChangesGuard";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "@/lib/admin-image-presentation";

interface BusinessSettings {
  companyName: string;
  legalName: string;
  taxId: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateRegion: string;
  postalCode: string;
  country: string;
  invoicePrefix: string;
  invoiceLogoUrl: string;
  invoiceFooterText: string;
}

const defaultValues: BusinessSettings = {
  companyName: "",
  legalName: "",
  taxId: "",
  phone: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateRegion: "",
  postalCode: "",
  country: "Bangladesh",
  invoicePrefix: "INV",
  invoiceLogoUrl: "",
  invoiceFooterText: "",
};

export default function BusinessSettingsBuilder() {
  const {
    values,
    setValue,
    isLoading,
    isLoaded,
    isLoadError,
    loadError,
    isSaving,
    isDirty,
    reset,
    handleSubmit,
    refetch,
  } = useSettingsForm<BusinessSettings>({
    queryKey: queryKeys.settings.business(),
    fetchFn: () => getBusinessSettings() as Promise<Partial<BusinessSettings>>,
    saveFn: (v) => updateBusinessSettings({ data: v as unknown as SettingsPayload }),
    defaultValues,
    successMessage: "Business settings saved",
    errorMessage: "Failed to save business settings.",
  });

  const invoiceLogoUrl = values.invoiceLogoUrl.trim()
    ? normalizePublicMediaUrl(values.invoiceLogoUrl)
    : null;
  const invoiceLogoInvalid = Boolean(
    values.invoiceLogoUrl.trim() && !invoiceLogoUrl,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isLoadError) {
    return (
      <SettingsLoadFailure
        title="Business identity unavailable"
        error={loadError}
        fallback="The company, address, and invoice settings could not be loaded."
        onRetry={refetch}
      />
    );
  }

  return (
    <div className="max-w-2xl space-y-5 [&_input]:min-h-11 md:[&_input]:min-h-9">
      <UnsavedChangesGuard isDirty={isDirty} isSubmitting={isSaving} />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Company Information</CardTitle>
          <CardDescription>
            Legal identity used on invoices and store schema.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Company Name</Label>
            <Input
              id="company-name"
              placeholder="e.g., Acme Commerce Ltd."
              value={values.companyName}
              onChange={(e) => setValue("companyName", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-name">Legal Name</Label>
            <Input
              id="legal-name"
              placeholder="Registered trade name"
              value={values.legalName}
              onChange={(e) => setValue("legalName", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Optional registered name if different from the company name.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="tax-id">Tax ID</Label>
              <Input
                id="tax-id"
                placeholder="e.g., 123456789"
                value={values.taxId}
                onChange={(e) => setValue("taxId", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                TIN or BIN, if applicable.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="business-phone">Phone</Label>
              <Input
                id="business-phone"
                placeholder="e.g., +880-1700-000000"
                value={values.phone}
                onChange={(e) => setValue("phone", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="business-email">Email</Label>
              <Input
                id="business-email"
                type="email"
                placeholder="e.g., info@acme.com"
                value={values.email}
                onChange={(e) => setValue("email", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Business Address</CardTitle>
          <CardDescription>
            Used on invoices and merchant records.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="address-line-1">Address Line 1</Label>
            <Input
              id="address-line-1"
              placeholder="Street address"
              value={values.addressLine1}
              onChange={(e) => setValue("addressLine1", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="address-line-2">Address Line 2</Label>
            <Input
              id="address-line-2"
              placeholder="Floor, suite, unit (optional)"
              value={values.addressLine2}
              onChange={(e) => setValue("addressLine2", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                placeholder="e.g., Dhaka"
                value={values.city}
                onChange={(e) => setValue("city", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="state-region">State/Region</Label>
              <Input
                id="state-region"
                placeholder="e.g., Dhaka Division"
                value={values.stateRegion}
                onChange={(e) => setValue("stateRegion", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="postal-code">Postal Code</Label>
              <Input
                id="postal-code"
                placeholder="e.g., 1205"
                value={values.postalCode}
                onChange={(e) => setValue("postalCode", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              placeholder="e.g., Bangladesh"
              value={values.country}
              onChange={(e) => setValue("country", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invoice Settings</CardTitle>
          <CardDescription>
            Numbering and branding for generated invoices.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invoice-prefix">Invoice Number Prefix</Label>
            <Input
              id="invoice-prefix"
              placeholder="e.g., INV"
              value={values.invoicePrefix}
              onChange={(e) => setValue("invoicePrefix", e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Preview: {values.invoicePrefix.trim() || "INV"}-00001
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-logo-url">Invoice logo</Label>
            <Input
              id="invoice-logo-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://cloud.example.com/logo.png"
              value={values.invoiceLogoUrl}
              onChange={(e) => setValue("invoiceLogoUrl", e.target.value)}
              aria-invalid={invoiceLogoInvalid}
              aria-describedby="invoice-logo-help invoice-logo-error"
            />
            {invoiceLogoInvalid ? (
              <p id="invoice-logo-error" role="alert" className="text-xs text-destructive">
                Use an HTTPS image URL or a root-relative application asset.
              </p>
            ) : null}
            <p id="invoice-logo-help" className="text-xs text-muted-foreground">
              Shown at the top of invoices without cropping.
            </p>
            {invoiceLogoUrl ? (
              <div className="flex min-h-20 items-center rounded-lg border bg-muted/20 p-3">
                <img
                  src={getOptimizedImageUrl(
                    invoiceLogoUrl,
                    ADMIN_IMAGE_PRESETS.invoiceLogo,
                  )}
                  alt="Invoice logo preview"
                  className="max-h-14 max-w-full object-contain"
                />
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-footer-text">Invoice Footer Text</Label>
            <textarea
              id="invoice-footer-text"
              placeholder="e.g., Thank you for your business!"
              value={values.invoiceFooterText}
              onChange={(e) => setValue("invoiceFooterText", e.target.value)}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 sm:flex sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={reset}
          disabled={isSaving || !isDirty}
          className="min-h-11 md:min-h-10"
        >
          <RotateCcw className="h-4 w-4" />
          Reset
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSaving || !isLoaded || !isDirty || invoiceLogoInvalid}
          className="min-h-11 min-w-[140px] md:min-h-10"
        >
          {isSaving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save business
        </Button>
      </div>
    </div>
  );
}
