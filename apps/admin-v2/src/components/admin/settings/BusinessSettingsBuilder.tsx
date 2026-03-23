import { useState, useEffect } from "react";
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
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { getServerFnError } from "@/lib/api-helpers";
import { getBusinessSettings, updateBusinessSettings } from "@/lib/api.functions";

export default function BusinessSettingsBuilder() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Company Information
  const [companyName, setCompanyName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Business Address
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateRegion, setStateRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Bangladesh");

  // Invoice Settings
  const [invoicePrefix, setInvoicePrefix] = useState("INV");
  const [invoiceLogoUrl, setInvoiceLogoUrl] = useState("");
  const [invoiceFooterText, setInvoiceFooterText] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const data = await getBusinessSettings() as Record<string, unknown>;
      setCompanyName((data.companyName as string) || "");
      setLegalName((data.legalName as string) || "");
      setTaxId((data.taxId as string) || "");
      setPhone((data.phone as string) || "");
      setEmail((data.email as string) || "");
      setAddressLine1((data.addressLine1 as string) || "");
      setAddressLine2((data.addressLine2 as string) || "");
      setCity((data.city as string) || "");
      setStateRegion((data.stateRegion as string) || "");
      setPostalCode((data.postalCode as string) || "");
      setCountry((data.country as string) || "Bangladesh");
      setInvoicePrefix((data.invoicePrefix as string) || "INV");
      setInvoiceLogoUrl((data.invoiceLogoUrl as string) || "");
      setInvoiceFooterText((data.invoiceFooterText as string) || "");
    } catch {
      toast.error("Failed to load business settings");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);

    try {
      await updateBusinessSettings({
        data: {
          companyName, legalName, addressLine1, addressLine2,
          city, stateRegion, postalCode, country,
          phone, email, taxId,
          invoicePrefix, invoiceFooterText, invoiceLogoUrl,
        },
      });
      toast.success("Business settings saved successfully!");
      fetchSettings();
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to save business settings"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
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
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="legal-name">Legal Name</Label>
            <Input
              id="legal-name"
              placeholder="Registered trade name"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
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
                value={taxId}
                onChange={(e) => setTaxId(e.target.value)}
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
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="address-line-2">Address Line 2</Label>
            <Input
              id="address-line-2"
              placeholder="Floor, suite, unit (optional)"
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
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
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="state-region">State/Region</Label>
              <Input
                id="state-region"
                placeholder="e.g., Dhaka Division"
                value={stateRegion}
                onChange={(e) => setStateRegion(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="postal-code">Postal Code</Label>
              <Input
                id="postal-code"
                placeholder="e.g., 1205"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="country">Country</Label>
            <Input
              id="country"
              placeholder="e.g., Bangladesh"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
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
              value={invoicePrefix}
              onChange={(e) => setInvoicePrefix(e.target.value)}
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
              value={invoiceLogoUrl}
              onChange={(e) => setInvoiceLogoUrl(e.target.value)}
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
              value={invoiceFooterText}
              onChange={(e) => setInvoiceFooterText(e.target.value)}
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
          disabled={saving}
          className="min-w-[140px]"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Business Settings
        </Button>
      </div>
    </div>
  );
}
