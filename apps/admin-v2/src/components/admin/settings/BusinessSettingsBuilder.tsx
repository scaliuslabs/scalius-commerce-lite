import {
  ContextualSaveBar,
  FieldError,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
} from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ImageIcon, Trash2, Upload } from "lucide-react";
import { useRef } from "react";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { queryKeys } from "~/lib/query-keys";
import {
  getBusinessSettings,
  type SettingsPayload,
  updateBusinessSettings,
} from "~/lib/api-functions/settings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import { MediaManager } from "../media-manager";

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
  const formRef = useRef<HTMLFormElement>(null);
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

  // Both the native submit and the save bar land here, so browser validation
  // still blocks a malformed email before the write leaves the page.
  function submitBusinessSettings() {
    if (isSaving || !isLoaded || !isDirty || invoiceLogoInvalid) return;
    const form = formRef.current;
    if (form && typeof form.checkValidity === "function" && !form.checkValidity()) {
      form.reportValidity?.();
      return;
    }
    void handleSubmit();
  }

  if (isLoading) {
    return (
      <SkeletonPage
        showHeader={false}
        sections={3}
        rowsPerSection={4}
        label="Loading business settings"
      />
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
    <form
      ref={formRef}
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        submitBusinessSettings();
      }}
      className="max-w-5xl [&_input]:min-h-11 sm:[&_input]:min-h-9"
    >
      <ContextualSaveBar
        isDirty={isDirty || isSaving}
        saving={isSaving}
        saveDisabled={isSaving || !isLoaded || !isDirty || invoiceLogoInvalid}
        saveDisabledReason="Fix the highlighted fields before saving."
        saveLabel="Save business"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={reset}
        onSave={submitBusinessSettings}
      />

      <div className="space-y-6">
        <SettingsSection
          title="Company information"
          description="Names the seller on invoices, receipts, and store schema."
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="company-name">Company name</Label>
              <Input
                id="company-name"
                placeholder="e.g., Acme Commerce Ltd."
                value={values.companyName}
                onChange={(e) => setValue("companyName", e.target.value)}
                aria-describedby="company-name-help"
              />
              <InlineHelp id="company-name-help">
                Buyers see this name on invoices and in store schema.
              </InlineHelp>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="legal-name">Legal name</Label>
              <Input
                id="legal-name"
                placeholder="Registered name, if different"
                value={values.legalName}
                onChange={(e) => setValue("legalName", e.target.value)}
                aria-describedby="legal-name-help"
              />
              <InlineHelp id="legal-name-help">
                Used instead of the company name where a registered entity is required.
              </InlineHelp>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tax-id">Tax ID</Label>
                <Input
                  id="tax-id"
                  placeholder="TIN or BIN (optional)"
                  value={values.taxId}
                  onChange={(e) => setValue("taxId", e.target.value)}
                  aria-describedby="tax-id-help"
                />
                <InlineHelp id="tax-id-help">
                  Printed on invoices when it is set.
                </InlineHelp>
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

            <div className="space-y-1.5">
              <Label htmlFor="business-email">Email</Label>
              <Input
                id="business-email"
                name="email"
                type="email"
                placeholder="e.g., info@acme.com"
                value={values.email}
                onChange={(e) => setValue("email", e.target.value)}
                aria-describedby="business-email-help"
              />
              <InlineHelp id="business-email-help">
                Customers reply to this address from invoices and order emails.
              </InlineHelp>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Business address"
          description="Appears on invoices and wherever a registered address is required."
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="address-line-1">Address line 1</Label>
              <Input
                id="address-line-1"
                placeholder="Street address"
                value={values.addressLine1}
                onChange={(e) => setValue("addressLine1", e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="address-line-2">Address line 2</Label>
              <Input
                id="address-line-2"
                placeholder="Floor, suite, unit (optional)"
                value={values.addressLine2}
                onChange={(e) => setValue("addressLine2", e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                <Label htmlFor="state-region">State/region</Label>
                <Input
                  id="state-region"
                  placeholder="e.g., Dhaka Division"
                  value={values.stateRegion}
                  onChange={(e) => setValue("stateRegion", e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="postal-code">Postal code</Label>
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
          </div>
        </SettingsSection>

        <SettingsSection
          title="Invoice settings"
          description="Controls how each generated invoice is numbered and branded."
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invoice-prefix">Invoice number prefix</Label>
              <Input
                id="invoice-prefix"
                placeholder="e.g., INV"
                value={values.invoicePrefix}
                onChange={(e) => setValue("invoicePrefix", e.target.value)}
                aria-describedby="invoice-prefix-help"
                className="max-w-xs"
              />
              <InlineHelp id="invoice-prefix-help">
                Preview: {values.invoicePrefix.trim() || "INV"}-00001
              </InlineHelp>
            </div>

            <div className="space-y-1.5">
              <Label>Invoice logo</Label>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-start">
                <div className="flex min-h-24 items-center justify-center rounded-lg border bg-muted/20 p-3">
                  {invoiceLogoUrl ? (
                  <img
                    src={getOptimizedImageUrl(
                      invoiceLogoUrl,
                      ADMIN_IMAGE_PRESETS.invoiceLogo,
                    )}
                    alt="Invoice logo preview"
                    className="max-h-14 max-w-full object-contain"
                  />
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
                      <ImageIcon className="size-6 opacity-50" />
                      No invoice logo
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <MediaManager
                    capability="image"
                    onSelect={(file) => setValue("invoiceLogoUrl", file.url)}
                    trigger={(
                      <Button type="button" variant="outline" className="min-h-11 w-full sm:min-h-9">
                        <Upload className="size-4" />
                        {invoiceLogoUrl ? "Change logo" : "Choose logo"}
                      </Button>
                    )}
                  />
                  {values.invoiceLogoUrl ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 w-full text-muted-foreground hover:text-destructive sm:min-h-9"
                      onClick={() => setValue("invoiceLogoUrl", "")}
                    >
                      <Trash2 className="size-4" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
              <details className="rounded-md border bg-background">
                <summary className="min-h-11 cursor-pointer list-none px-3 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  Image URL
                </summary>
                <div className="border-t p-3">
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
                    <FieldError id="invoice-logo-error" className="mt-1.5">
                      Use an HTTPS image URL or a root-relative application asset.
                    </FieldError>
                  ) : null}
                </div>
              </details>
              <InlineHelp id="invoice-logo-help">
                Shown at the top of invoices without cropping.
              </InlineHelp>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invoice-footer-text">Invoice footer text</Label>
              <textarea
                id="invoice-footer-text"
                placeholder="e.g., Thank you for your business"
                value={values.invoiceFooterText}
                onChange={(e) => setValue("invoiceFooterText", e.target.value)}
                rows={3}
                aria-describedby="invoice-footer-help"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <InlineHelp id="invoice-footer-help">
                Printed under the totals on every invoice.
              </InlineHelp>
            </div>
          </div>
        </SettingsSection>
      </div>

      {/*
        Keeps the native POST and Enter-to-submit path working before hydration
        and without JavaScript. The visible Save lives in the save bar above.
      */}
      <button type="submit" tabIndex={-1} aria-hidden="true" className="hidden">
        Save business
      </button>
    </form>
  );
}
