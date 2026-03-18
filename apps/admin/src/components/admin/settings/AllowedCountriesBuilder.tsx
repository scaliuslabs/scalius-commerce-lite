import { useState, useEffect, useMemo } from "react";
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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Save, X, Search } from "lucide-react";
import { getCountries, getCountryCallingCode } from "react-phone-number-input";
import en from "react-phone-number-input/locale/en";
import type { Country } from "react-phone-number-input";

interface CountryOption {
  value: Country;
  label: string;
  callingCode: string;
}

const ALL_COUNTRIES: CountryOption[] = getCountries().map((code) => ({
  value: code,
  label: en[code] || code,
  callingCode: getCountryCallingCode(code),
}));

export default function AllowedCountriesBuilder() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Country[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await fetch("/api/v1/admin/settings/site");
      if (res.ok) {
        const json = await res.json();
        const data =
          json.data && typeof json.data === "object" && !Array.isArray(json.data)
            ? json.data
            : json;
        if (Array.isArray(data.allowedCountries)) {
          setSelected(data.allowedCountries as Country[]);
        }
      }
    } catch {
      toast.error("Failed to load allowed countries");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/admin/settings/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedCountries: selected }),
      });

      if (res.ok) {
        toast.success("Allowed countries saved successfully!");
      } else {
        const err = await res.json();
        toast.error(err.message || "Failed to save allowed countries");
      }
    } catch {
      toast.error("An error occurred while saving");
    } finally {
      setSaving(false);
    }
  };

  const toggleCountry = (code: Country) => {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const removeCountry = (code: Country) => {
    setSelected((prev) => prev.filter((c) => c !== code));
  };

  const filteredCountries = useMemo(() => {
    if (!search.trim()) return ALL_COUNTRIES;
    const q = search.toLowerCase();
    return ALL_COUNTRIES.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.value.toLowerCase().includes(q) ||
        `+${c.callingCode}`.includes(q),
    );
  }, [search]);

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
          <CardTitle className="text-base">Allowed Countries</CardTitle>
          <CardDescription>
            Restrict which countries can be used for phone numbers during
            checkout and customer registration. Leave empty to allow all
            countries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {selected.length > 0 && (
            <div className="space-y-1.5">
              <Label>Selected ({selected.length})</Label>
              <div className="flex flex-wrap gap-1.5">
                {selected.map((code) => {
                  const country = ALL_COUNTRIES.find((c) => c.value === code);
                  return (
                    <Badge
                      key={code}
                      variant="secondary"
                      className="gap-1 pr-1"
                    >
                      {country ? country.label : code} (+
                      {country ? country.callingCode : "?"})
                      <button
                        type="button"
                        onClick={() => removeCountry(code)}
                        className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="country-search">Search countries</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="country-search"
                placeholder="Search by name, code, or calling code..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <div className="border rounded-md max-h-64 overflow-y-auto">
            {filteredCountries.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No countries match your search.
              </div>
            ) : (
              <div className="divide-y">
                {filteredCountries.map((country) => {
                  const isSelected = selected.includes(country.value);
                  return (
                    <button
                      key={country.value}
                      type="button"
                      onClick={() => toggleCountry(country.value)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors ${
                        isSelected ? "bg-muted/30" : ""
                      }`}
                    >
                      <span>
                        {country.label}{" "}
                        <span className="text-muted-foreground">
                          (+{country.callingCode})
                        </span>
                      </span>
                      {isSelected && (
                        <Badge variant="default" className="text-xs">
                          Selected
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selected.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No restrictions set. All countries are currently accepted.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={handleSave}
          disabled={saving}
          className="min-w-[140px]"
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          <Save className="mr-2 h-4 w-4" />
          Save Allowed Countries
        </Button>
      </div>
    </div>
  );
}
