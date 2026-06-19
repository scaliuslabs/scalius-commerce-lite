import React, { useState, useMemo, useRef, useEffect } from "react";
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
import { Loader2, Save, Info, Search, Check } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cn } from "@scalius/shared/utils";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
  getCurrencySettings,
  type SettingsPayload,
  updateCurrencySettings,
} from "@/lib/api-functions/currency";

interface CurrencyEntry {
  code: string;
  symbol: string;
  name: string;
  decimalPlaces: number;
}

const CURRENCIES: CurrencyEntry[] = [
  // ── Major / Global ──
  { code: "USD", symbol: "$", name: "US Dollar", decimalPlaces: 2 },
  { code: "EUR", symbol: "\u20AC", name: "Euro", decimalPlaces: 2 },
  { code: "GBP", symbol: "\u00A3", name: "British Pound", decimalPlaces: 2 },
  { code: "JPY", symbol: "\u00A5", name: "Japanese Yen", decimalPlaces: 0 },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc", decimalPlaces: 2 },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar", decimalPlaces: 2 },
  { code: "AUD", symbol: "A$", name: "Australian Dollar", decimalPlaces: 2 },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar", decimalPlaces: 2 },
  { code: "CNY", symbol: "\u00A5", name: "Chinese Yuan", decimalPlaces: 2 },
  { code: "HKD", symbol: "HK$", name: "Hong Kong Dollar", decimalPlaces: 2 },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar", decimalPlaces: 2 },
  { code: "SEK", symbol: "kr", name: "Swedish Krona", decimalPlaces: 2 },
  { code: "NOK", symbol: "kr", name: "Norwegian Krone", decimalPlaces: 2 },
  { code: "DKK", symbol: "kr", name: "Danish Krone", decimalPlaces: 2 },
  { code: "MXN", symbol: "MX$", name: "Mexican Peso", decimalPlaces: 2 },
  { code: "BRL", symbol: "R$", name: "Brazilian Real", decimalPlaces: 2 },

  // ── South Asia ──
  { code: "BDT", symbol: "\u09F3", name: "Bangladeshi Taka", decimalPlaces: 2 },
  { code: "INR", symbol: "\u20B9", name: "Indian Rupee", decimalPlaces: 2 },
  { code: "PKR", symbol: "\u20A8", name: "Pakistani Rupee", decimalPlaces: 2 },
  { code: "LKR", symbol: "Rs", name: "Sri Lankan Rupee", decimalPlaces: 2 },
  { code: "NPR", symbol: "\u0930\u0942", name: "Nepalese Rupee", decimalPlaces: 2 },
  { code: "AFN", symbol: "\u060B", name: "Afghan Afghani", decimalPlaces: 2 },
  { code: "BTN", symbol: "Nu", name: "Bhutanese Ngultrum", decimalPlaces: 2 },
  { code: "MVR", symbol: "Rf", name: "Maldivian Rufiyaa", decimalPlaces: 2 },

  // ── Southeast Asia ──
  { code: "MYR", symbol: "RM", name: "Malaysian Ringgit", decimalPlaces: 2 },
  { code: "PHP", symbol: "\u20B1", name: "Philippine Peso", decimalPlaces: 2 },
  { code: "THB", symbol: "\u0E3F", name: "Thai Baht", decimalPlaces: 2 },
  { code: "IDR", symbol: "Rp", name: "Indonesian Rupiah", decimalPlaces: 2 },
  { code: "VND", symbol: "\u20AB", name: "Vietnamese Dong", decimalPlaces: 0 },
  { code: "MMK", symbol: "K", name: "Myanmar Kyat", decimalPlaces: 2 },
  { code: "KHR", symbol: "\u17DB", name: "Cambodian Riel", decimalPlaces: 2 },
  { code: "LAK", symbol: "\u20AD", name: "Lao Kip", decimalPlaces: 2 },
  { code: "BND", symbol: "B$", name: "Brunei Dollar", decimalPlaces: 2 },

  // ── East Asia ──
  { code: "KRW", symbol: "\u20A9", name: "South Korean Won", decimalPlaces: 0 },
  { code: "TWD", symbol: "NT$", name: "New Taiwan Dollar", decimalPlaces: 2 },
  { code: "MNT", symbol: "\u20AE", name: "Mongolian Tugrik", decimalPlaces: 2 },
  { code: "KPW", symbol: "\u20A9", name: "North Korean Won", decimalPlaces: 2 },
  { code: "MOP", symbol: "MOP$", name: "Macanese Pataca", decimalPlaces: 2 },

  // ── Middle East ──
  { code: "AED", symbol: "\u062F.\u0625", name: "UAE Dirham", decimalPlaces: 2 },
  { code: "SAR", symbol: "\uFDFC", name: "Saudi Riyal", decimalPlaces: 2 },
  { code: "QAR", symbol: "\uFDFC", name: "Qatari Riyal", decimalPlaces: 2 },
  { code: "KWD", symbol: "\u062F.\u0643", name: "Kuwaiti Dinar", decimalPlaces: 3 },
  { code: "BHD", symbol: "BD", name: "Bahraini Dinar", decimalPlaces: 3 },
  { code: "OMR", symbol: "\u0631.\u0639.", name: "Omani Rial", decimalPlaces: 3 },
  { code: "JOD", symbol: "JD", name: "Jordanian Dinar", decimalPlaces: 3 },
  { code: "IQD", symbol: "\u0639.\u062F", name: "Iraqi Dinar", decimalPlaces: 3 },
  { code: "IRR", symbol: "\uFDFC", name: "Iranian Rial", decimalPlaces: 2 },
  { code: "YER", symbol: "\uFDFC", name: "Yemeni Rial", decimalPlaces: 2 },
  { code: "LBP", symbol: "L\u00A3", name: "Lebanese Pound", decimalPlaces: 2 },
  { code: "SYP", symbol: "\u00A3S", name: "Syrian Pound", decimalPlaces: 2 },
  { code: "ILS", symbol: "\u20AA", name: "Israeli New Shekel", decimalPlaces: 2 },

  // ── Central Asia ──
  { code: "KZT", symbol: "\u20B8", name: "Kazakhstani Tenge", decimalPlaces: 2 },
  { code: "UZS", symbol: "s\u02BBm", name: "Uzbekistani Som", decimalPlaces: 2 },
  { code: "KGS", symbol: "\u043B\u0432", name: "Kyrgyzstani Som", decimalPlaces: 2 },
  { code: "TJS", symbol: "SM", name: "Tajikistani Somoni", decimalPlaces: 2 },
  { code: "TMT", symbol: "T", name: "Turkmenistani Manat", decimalPlaces: 2 },
  { code: "GEL", symbol: "\u20BE", name: "Georgian Lari", decimalPlaces: 2 },
  { code: "AMD", symbol: "\u058F", name: "Armenian Dram", decimalPlaces: 2 },
  { code: "AZN", symbol: "\u20BC", name: "Azerbaijani Manat", decimalPlaces: 2 },

  // ── Europe ──
  { code: "TRY", symbol: "\u20BA", name: "Turkish Lira", decimalPlaces: 2 },
  { code: "RUB", symbol: "\u20BD", name: "Russian Ruble", decimalPlaces: 2 },
  { code: "UAH", symbol: "\u20B4", name: "Ukrainian Hryvnia", decimalPlaces: 2 },
  { code: "PLN", symbol: "z\u0142", name: "Polish Zloty", decimalPlaces: 2 },
  { code: "CZK", symbol: "K\u010D", name: "Czech Koruna", decimalPlaces: 2 },
  { code: "HUF", symbol: "Ft", name: "Hungarian Forint", decimalPlaces: 2 },
  { code: "RON", symbol: "lei", name: "Romanian Leu", decimalPlaces: 2 },
  { code: "BGN", symbol: "\u043B\u0432", name: "Bulgarian Lev", decimalPlaces: 2 },
  { code: "HRK", symbol: "kn", name: "Croatian Kuna", decimalPlaces: 2 },
  { code: "RSD", symbol: "din", name: "Serbian Dinar", decimalPlaces: 2 },
  { code: "BAM", symbol: "KM", name: "Bosnia-Herzegovina Mark", decimalPlaces: 2 },
  { code: "MKD", symbol: "\u0434\u0435\u043D", name: "Macedonian Denar", decimalPlaces: 2 },
  { code: "ALL", symbol: "L", name: "Albanian Lek", decimalPlaces: 2 },
  { code: "MDL", symbol: "L", name: "Moldovan Leu", decimalPlaces: 2 },
  { code: "BYN", symbol: "Br", name: "Belarusian Ruble", decimalPlaces: 2 },
  { code: "ISK", symbol: "kr", name: "Icelandic Krona", decimalPlaces: 0 },

  // ── Americas ──
  { code: "ARS", symbol: "AR$", name: "Argentine Peso", decimalPlaces: 2 },
  { code: "CLP", symbol: "CL$", name: "Chilean Peso", decimalPlaces: 0 },
  { code: "COP", symbol: "COL$", name: "Colombian Peso", decimalPlaces: 2 },
  { code: "PEN", symbol: "S/", name: "Peruvian Sol", decimalPlaces: 2 },
  { code: "UYU", symbol: "$U", name: "Uruguayan Peso", decimalPlaces: 2 },
  { code: "PYG", symbol: "\u20B2", name: "Paraguayan Guarani", decimalPlaces: 0 },
  { code: "BOB", symbol: "Bs.", name: "Bolivian Boliviano", decimalPlaces: 2 },
  { code: "VES", symbol: "Bs.S", name: "Venezuelan Bolivar", decimalPlaces: 2 },
  { code: "GYD", symbol: "G$", name: "Guyanese Dollar", decimalPlaces: 2 },
  { code: "SRD", symbol: "SR$", name: "Surinamese Dollar", decimalPlaces: 2 },
  { code: "TTD", symbol: "TT$", name: "Trinidad and Tobago Dollar", decimalPlaces: 2 },
  { code: "JMD", symbol: "J$", name: "Jamaican Dollar", decimalPlaces: 2 },
  { code: "BBD", symbol: "Bds$", name: "Barbadian Dollar", decimalPlaces: 2 },
  { code: "BSD", symbol: "B$", name: "Bahamian Dollar", decimalPlaces: 2 },
  { code: "BZD", symbol: "BZ$", name: "Belize Dollar", decimalPlaces: 2 },
  { code: "CRC", symbol: "\u20A1", name: "Costa Rican Colon", decimalPlaces: 2 },
  { code: "CUP", symbol: "$MN", name: "Cuban Peso", decimalPlaces: 2 },
  { code: "DOP", symbol: "RD$", name: "Dominican Peso", decimalPlaces: 2 },
  { code: "GTQ", symbol: "Q", name: "Guatemalan Quetzal", decimalPlaces: 2 },
  { code: "HNL", symbol: "L", name: "Honduran Lempira", decimalPlaces: 2 },
  { code: "HTG", symbol: "G", name: "Haitian Gourde", decimalPlaces: 2 },
  { code: "NIO", symbol: "C$", name: "Nicaraguan Cordoba", decimalPlaces: 2 },
  { code: "PAB", symbol: "B/.", name: "Panamanian Balboa", decimalPlaces: 2 },
  { code: "AWG", symbol: "\u0192", name: "Aruban Florin", decimalPlaces: 2 },
  { code: "ANG", symbol: "\u0192", name: "Netherlands Antillean Guilder", decimalPlaces: 2 },
  { code: "KYD", symbol: "CI$", name: "Cayman Islands Dollar", decimalPlaces: 2 },
  { code: "BMD", symbol: "BD$", name: "Bermudian Dollar", decimalPlaces: 2 },
  { code: "XCD", symbol: "EC$", name: "East Caribbean Dollar", decimalPlaces: 2 },
  { code: "FKP", symbol: "\u00A3", name: "Falkland Islands Pound", decimalPlaces: 2 },

  // ── Africa — West ──
  { code: "NGN", symbol: "\u20A6", name: "Nigerian Naira", decimalPlaces: 2 },
  { code: "GHS", symbol: "\u20B5", name: "Ghanaian Cedi", decimalPlaces: 2 },
  { code: "XOF", symbol: "CFA", name: "West African CFA Franc", decimalPlaces: 0 },
  { code: "GMD", symbol: "D", name: "Gambian Dalasi", decimalPlaces: 2 },
  { code: "GNF", symbol: "FG", name: "Guinean Franc", decimalPlaces: 0 },
  { code: "SLL", symbol: "Le", name: "Sierra Leonean Leone", decimalPlaces: 2 },
  { code: "LRD", symbol: "L$", name: "Liberian Dollar", decimalPlaces: 2 },
  { code: "CVE", symbol: "Esc", name: "Cape Verdean Escudo", decimalPlaces: 2 },
  { code: "MRU", symbol: "UM", name: "Mauritanian Ouguiya", decimalPlaces: 2 },

  // ── Africa — East ──
  { code: "KES", symbol: "KSh", name: "Kenyan Shilling", decimalPlaces: 2 },
  { code: "TZS", symbol: "TSh", name: "Tanzanian Shilling", decimalPlaces: 2 },
  { code: "UGX", symbol: "USh", name: "Ugandan Shilling", decimalPlaces: 0 },
  { code: "RWF", symbol: "FRw", name: "Rwandan Franc", decimalPlaces: 0 },
  { code: "BIF", symbol: "FBu", name: "Burundian Franc", decimalPlaces: 0 },
  { code: "ETB", symbol: "Br", name: "Ethiopian Birr", decimalPlaces: 2 },
  { code: "SOS", symbol: "Sh", name: "Somali Shilling", decimalPlaces: 2 },
  { code: "ERN", symbol: "Nfk", name: "Eritrean Nakfa", decimalPlaces: 2 },
  { code: "DJF", symbol: "Fdj", name: "Djiboutian Franc", decimalPlaces: 0 },
  { code: "SDG", symbol: "\u00A3SD", name: "Sudanese Pound", decimalPlaces: 2 },
  { code: "SSP", symbol: "\u00A3", name: "South Sudanese Pound", decimalPlaces: 2 },
  { code: "SCR", symbol: "SRe", name: "Seychellois Rupee", decimalPlaces: 2 },
  { code: "KMF", symbol: "CF", name: "Comorian Franc", decimalPlaces: 0 },
  { code: "MGA", symbol: "Ar", name: "Malagasy Ariary", decimalPlaces: 2 },
  { code: "MUR", symbol: "\u20A8", name: "Mauritian Rupee", decimalPlaces: 2 },

  // ── Africa — Central ──
  { code: "XAF", symbol: "FCFA", name: "Central African CFA Franc", decimalPlaces: 0 },
  { code: "CDF", symbol: "FC", name: "Congolese Franc", decimalPlaces: 2 },

  // ── Africa — Southern ──
  { code: "ZAR", symbol: "R", name: "South African Rand", decimalPlaces: 2 },
  { code: "BWP", symbol: "P", name: "Botswana Pula", decimalPlaces: 2 },
  { code: "LSL", symbol: "L", name: "Lesotho Loti", decimalPlaces: 2 },
  { code: "SZL", symbol: "E", name: "Eswatini Lilangeni", decimalPlaces: 2 },
  { code: "NAD", symbol: "N$", name: "Namibian Dollar", decimalPlaces: 2 },
  { code: "MWK", symbol: "MK", name: "Malawian Kwacha", decimalPlaces: 2 },
  { code: "ZMW", symbol: "ZK", name: "Zambian Kwacha", decimalPlaces: 2 },
  { code: "MZN", symbol: "MT", name: "Mozambican Metical", decimalPlaces: 2 },
  { code: "AOA", symbol: "Kz", name: "Angolan Kwanza", decimalPlaces: 2 },
  { code: "ZWL", symbol: "Z$", name: "Zimbabwean Dollar", decimalPlaces: 2 },

  // ── Africa — North ──
  { code: "EGP", symbol: "E\u00A3", name: "Egyptian Pound", decimalPlaces: 2 },
  { code: "DZD", symbol: "\u062F.\u062C", name: "Algerian Dinar", decimalPlaces: 2 },
  { code: "MAD", symbol: "MAD", name: "Moroccan Dirham", decimalPlaces: 2 },
  { code: "TND", symbol: "DT", name: "Tunisian Dinar", decimalPlaces: 3 },
  { code: "LYD", symbol: "LD", name: "Libyan Dinar", decimalPlaces: 3 },
  { code: "STN", symbol: "Db", name: "Sao Tome and Principe Dobra", decimalPlaces: 2 },

  // ── Pacific / Oceania ──
  { code: "FJD", symbol: "FJ$", name: "Fijian Dollar", decimalPlaces: 2 },
  { code: "PGK", symbol: "K", name: "Papua New Guinean Kina", decimalPlaces: 2 },
  { code: "WST", symbol: "WS$", name: "Samoan Tala", decimalPlaces: 2 },
  { code: "TOP", symbol: "T$", name: "Tongan Pa'anga", decimalPlaces: 2 },
  { code: "VUV", symbol: "VT", name: "Vanuatu Vatu", decimalPlaces: 0 },
  { code: "SBD", symbol: "SI$", name: "Solomon Islands Dollar", decimalPlaces: 2 },
  { code: "XPF", symbol: "\u20A3", name: "CFP Franc", decimalPlaces: 0 },

  // ── Special / Other ──
  { code: "XDR", symbol: "SDR", name: "Special Drawing Rights", decimalPlaces: 2 },
  { code: "XAG", symbol: "XAG", name: "Silver (troy ounce)", decimalPlaces: 2 },
  { code: "XAU", symbol: "XAU", name: "Gold (troy ounce)", decimalPlaces: 2 },
];

const currencyMap = new Map<string, CurrencyEntry>(CURRENCIES.map((c) => [c.code, c]));

interface CurrencySettings {
  currencyCode: string;
  currencySymbol: string;
  usdExchangeRate: string;
}

export default function CurrencySettingsBuilder() {
  const { values, setValue, setValues, isLoading, isSaving, handleSubmit } = useSettingsForm<CurrencySettings>({
    queryKey: queryKeys.settings.currency(),
    fetchFn: () => getCurrencySettings() as Promise<Partial<CurrencySettings>>,
    saveFn: (v) => updateCurrencySettings({ data: v as unknown as SettingsPayload }),
    defaultValues: { currencyCode: "BDT", currencySymbol: "\u09F3", usdExchangeRate: "1" },
    successMessage: "Currency settings saved successfully!",
    errorMessage: "Failed to save currency settings",
  });

  // UI-only state for the currency picker
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const handleCurrencySelect = (code: string) => {
    const currency = currencyMap.get(code);
    if (currency) {
      setValues((prev) => ({ ...prev, currencyCode: code, currencySymbol: currency.symbol }));
    } else {
      setValue("currencyCode", code);
    }
    setPickerOpen(false);
    setSearch("");
  };

  const filteredCurrencies = useMemo(() => {
    if (!search.trim()) return CURRENCIES;
    const q = search.toLowerCase();
    return CURRENCIES.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q),
    );
  }, [search]);

  const selectedCurrency = currencyMap.get(values.currencyCode);

  if (isLoading) {
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

          <div className="space-y-1.5" ref={containerRef}>
            <Label>Currency</Label>
            {selectedCurrency && (
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="text-sm px-3 py-1">
                  {selectedCurrency.code} - {selectedCurrency.name} ({selectedCurrency.symbol})
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {selectedCurrency.decimalPlaces} decimal place{selectedCurrency.decimalPlaces !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by code, name, or symbol..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPickerOpen(true);
                }}
                onFocus={() => setPickerOpen(true)}
                className="pl-9"
              />
            </div>
            {pickerOpen && (
              <div className="border rounded-md max-h-64 overflow-y-auto mt-1">
                {filteredCurrencies.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No currencies match your search.
                  </div>
                ) : (
                  <div className="divide-y">
                    {filteredCurrencies.map((c) => {
                      const isSelected = c.code === values.currencyCode;
                      return (
                        <button
                          key={c.code}
                          type="button"
                          onClick={() => handleCurrencySelect(c.code)}
                          className={cn(
                            "flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors",
                            isSelected && "bg-muted/30",
                          )}
                        >
                          <span>
                            <span className="font-medium">{c.code}</span>
                            {" - "}
                            {c.name}{" "}
                            <span className="text-muted-foreground">
                              ({c.symbol})
                            </span>
                          </span>
                          {isSelected && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="currency-symbol">Currency Symbol</Label>
            <Input
              id="currency-symbol"
              placeholder="e.g. ৳"
              value={values.currencySymbol}
              onChange={(e) => setValue("currencySymbol", e.target.value)}
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
              value={values.usdExchangeRate}
              onChange={(e) => setValue("usdExchangeRate", e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              How many {values.currencyCode} equal 1 USD. Example: if 1 USD = 120 {values.currencyCode}, enter 120.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={() => handleSubmit()}
          disabled={isSaving}
          className="min-w-[140px]"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Currency Settings
        </Button>
      </div>
    </div>
  );
}
