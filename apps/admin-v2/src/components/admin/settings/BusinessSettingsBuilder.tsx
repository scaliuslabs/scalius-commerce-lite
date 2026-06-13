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
import { Loader2, Save } from "lucide-react";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getBusinessSettings,
  type SettingsPayload,
  updateBusinessSettings,
} from "@/lib/api-functions/settings";

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
  const { values, setValue, isLoading, isSaving, handleSubmit } = useSettingsForm<BusinessSettings>({
    queryKey: queryKeys.settings.business(),
    fetchFn: () => getBusinessSettings() as Promise<Partial<BusinessSettings>>,
    saveFn: (v) => updateBusinessSettings({ data: v as unknown as SettingsPayload }),
    defaultValues,
    successMessage: "Business settings saved successfully!",
    errorMessage: "Failed to save business settings",
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Company Information */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Company Information</CardTitle>
          <CardDescription>
            Your business identity as it appears on invoices and legal documents.
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
              Registered trade name, if different from company name
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
                TIN or BIN number for Bangladesh merchants
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

      {/* Business Address */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Business Address</CardTitle>
          <CardDescription>
            Address shown on invoices and business correspondence.
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
            <p className="text-xs text-muted-foreground">
              Floor, suite, unit (optional)
            </p>
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

      {/* Invoice Settings */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Invoice Settings</CardTitle>
          <CardDescription>
            Configure how your invoices look and behave.
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
              e.g., INV. Invoice numbers will be formatted as INV-00001
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invoice-logo-url">Invoice Logo URL</Label>
            <Input
              id="invoice-logo-url"
              placeholder="https://cloud.example.com/logo.png"
              value={values.invoiceLogoUrl}
              onChange={(e) => setValue("invoiceLogoUrl", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Paste the URL of your logo from the media library. The logo appears at the top of invoices.
            </p>
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
            <p className="text-xs text-muted-foreground">
              Custom text at the bottom of every invoice, e.g., "Thank you for your business!"
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={() => handleSubmit()}
          disabled={isSaving}
          className="min-w-[140px]"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Business Settings
        </Button>
      </div>
    </div>
  );
}
