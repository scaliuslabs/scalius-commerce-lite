import React, { useState, useEffect } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Save, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const CURRENCIES = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "BDT", symbol: "৳", name: "Bangladeshi Taka" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "PKR", symbol: "₨", name: "Pakistani Rupee" },
  { code: "LKR", symbol: "Rs", name: "Sri Lankan Rupee" },
  { code: "NPR", symbol: "रू", name: "Nepalese Rupee" },
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "PHP", symbol: "₱", name: "Philippine Peso" },
  { code: "THB", symbol: "฿", name: "Thai Baht" },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah" },
  { code: "VND", symbol: "₫", name: "Vietnamese Dong" },
  { code: "KRW", symbol: "₩", name: "South Korean Won" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "TWD", symbol: "NT$", name: "New Taiwan Dollar" },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
  { code: "SAR", symbol: "﷼", name: "Saudi Riyal" },
  { code: "QAR", symbol: "﷼", name: "Qatari Riyal" },
  { code: "KWD", symbol: "د.ك", name: "Kuwaiti Dinar" },
  { code: "TRY", symbol: "₺", name: "Turkish Lira" },
  { code: "NGN", symbol: "₦", name: "Nigerian Naira" },
  { code: "GHS", symbol: "₵", name: "Ghanaian Cedi" },
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling" },
  { code: "ZAR", symbol: "R", name: "South African Rand" },
  { code: "EGP", symbol: "E£", name: "Egyptian Pound" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar" },
  { code: "SEK", symbol: "kr", name: "Swedish Krona" },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone" },
  { code: "DKK", symbol: "kr", name: "Danish Krone" },
  { code: "BRL", symbol: "R$", name: "Brazilian Real" },
  { code: "MXN", symbol: "MX$", name: "Mexican Peso" },
  { code: "ARS", symbol: "AR$", name: "Argentine Peso" },
  { code: "CLP", symbol: "CL$", name: "Chilean Peso" },
  { code: "COP", symbol: "COL$", name: "Colombian Peso" },
  { code: "PEN", symbol: "S/", name: "Peruvian Sol" },
  { code: "MMK", symbol: "K", name: "Myanmar Kyat" },
  { code: "KHR", symbol: "៛", name: "Cambodian Riel" },
  { code: "AFN", symbol: "؋", name: "Afghan Afghani" },
] as const;

const currencyMap = new Map<string, typeof CURRENCIES[number]>(CURRENCIES.map((c) => [c.code, c]));

export default function CurrencySettingsBuilder() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currencyCode, setCurrencyCode] = useState("BDT");
  const [currencySymbol, setCurrencySymbol] = useState("\u09F3");
  const [usdExchangeRate, setUsdExchangeRate] = useState("1");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings/currency");
      if (res.ok) {
        const json = await res.json();
        const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
        setCurrencyCode(data.currencyCode || "BDT");
        setCurrencySymbol(data.currencySymbol || "\u09F3");
        setUsdExchangeRate(data.usdExchangeRate || "1");
      }
    } catch {
      toast.error("Failed to load currency settings");
    } finally {
      setLoading(false);
    }
  };

  const handleCurrencyChange = (code: string) => {
    setCurrencyCode(code);
    const currency = currencyMap.get(code);
    if (currency) {
      setCurrencySymbol(currency.symbol);
    }
  };

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    setSaving(true);

    try {
      const res = await fetch("/api/v1/admin/settings/currency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currencyCode,
          currencySymbol,
          usdExchangeRate,
        }),
      });

      if (res.ok) {
        toast.success("Currency settings saved successfully!");
        fetchSettings();
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to save currency settings");
      }
    } catch {
      toast.error("An error occurred while saving");
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
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Local Currency</CardTitle>
          <CardDescription>
            Configure your store's local currency and its exchange rate to USD.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-sm">
              Your local currency is used with SSLCommerz and Cash on Delivery. USD is always available via Stripe.
            </AlertDescription>
          </Alert>

          <div className="space-y-1.5">
            <Label htmlFor="currency-code">Currency</Label>
            <Select value={currencyCode} onValueChange={handleCurrencyChange}>
              <SelectTrigger id="currency-code" className="w-full">
                <SelectValue placeholder="Select currency" />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.code} - {c.name} ({c.symbol})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="currency-symbol">Currency Symbol</Label>
            <Input
              id="currency-symbol"
              placeholder="e.g. ৳"
              value={currencySymbol}
              onChange={(e) => setCurrencySymbol(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Auto-filled from currency selection. You can override if needed.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="usd-exchange-rate">USD Exchange Rate</Label>
            <Input
              id="usd-exchange-rate"
              type="number"
              min="0"
              step="any"
              placeholder="e.g. 120"
              value={usdExchangeRate}
              onChange={(e) => setUsdExchangeRate(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              How many {currencyCode} equal 1 USD. Example: if 1 USD = 120 {currencyCode}, enter 120.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={() => handleSubmit()}
          disabled={saving}
          className="min-w-[140px]"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Currency Settings
        </Button>
      </div>
    </div>
  );
}
