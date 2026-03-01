import { useState, useEffect, useCallback } from "react";
import { Loader2, RotateCcw, Save, Palette } from "lucide-react";

// ---------------------------------------------------------------------------
// Default storefront colors (must match global.css :root vars in storefront).
// These are used as the initial/fallback values and for the "Reset" button.
// We store oklch values but allow the admin to edit simplified hex colors that
// get converted. For a v1 we keep it simple: store hex strings that the
// storefront will inject as CSS custom-property overrides.
// ---------------------------------------------------------------------------

const COLOR_FIELDS = [
    { key: "primary", label: "Primary", description: "Buttons, links, accents" },
    { key: "primary-foreground", label: "Primary Foreground", description: "Text on primary backgrounds" },
    { key: "background", label: "Background", description: "Page background" },
    { key: "foreground", label: "Foreground", description: "Main text color" },
    { key: "secondary", label: "Secondary", description: "Secondary surfaces" },
    { key: "secondary-foreground", label: "Secondary Foreground", description: "Text on secondary surfaces" },
    { key: "card", label: "Card", description: "Card backgrounds" },
    { key: "card-foreground", label: "Card Foreground", description: "Text inside cards" },
    { key: "muted", label: "Muted", description: "Muted/disabled surfaces" },
    { key: "muted-foreground", label: "Muted Foreground", description: "Muted text" },
    { key: "accent", label: "Accent", description: "Accent surfaces" },
    { key: "accent-foreground", label: "Accent Foreground", description: "Text on accent surfaces" },
    { key: "destructive", label: "Destructive", description: "Error/danger actions" },
    { key: "border", label: "Border", description: "Default border color" },
    { key: "input", label: "Input", description: "Input border color" },
    { key: "ring", label: "Ring", description: "Focus ring color" },
] as const;

type ColorKey = (typeof COLOR_FIELDS)[number]["key"];

export default function ThemeSettingsPage() {
    const [colors, setColors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

    const fetchColors = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch("/api/settings/theme");
            if (!res.ok) throw new Error("Failed to load");
            const data = await res.json();
            setColors(data.colors || {});
        } catch {
            setMessage({ type: "error", text: "Failed to load theme settings." });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchColors();
    }, [fetchColors]);

    const handleChange = (key: ColorKey, value: string) => {
        setColors((prev) => ({ ...prev, [key]: value }));
        setDirty(true);
        setMessage(null);
    };

    const handleReset = () => {
        setColors({});
        setDirty(true);
        setMessage(null);
    };

    const handleSave = async () => {
        try {
            setSaving(true);
            setMessage(null);
            // Strip empty values so only actual overrides are persisted
            const cleaned: Record<string, string> = {};
            for (const [k, v] of Object.entries(colors)) {
                if (v && v.trim()) cleaned[k] = v.trim();
            }
            const res = await fetch("/api/settings/theme", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ colors: cleaned }),
            });
            if (!res.ok) throw new Error("Save failed");
            setDirty(false);
            setMessage({ type: "success", text: "Theme saved. Storefront cache has been invalidated." });
        } catch {
            setMessage({ type: "error", text: "Failed to save theme settings." });
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
        <div className="max-w-5xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                    <Palette className="h-6 w-6" />
                    Storefront Theme
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Customize the storefront color palette. Leave a field empty to use the
                    default. Changes are reflected on the storefront after save.
                </p>
            </div>

            {message && (
                <div
                    className={`mb-4 px-4 py-3 rounded-md text-sm font-medium ${message.type === "success"
                            ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-300"
                            : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300"
                        }`}
                >
                    {message.text}
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {COLOR_FIELDS.map((field) => (
                    <div
                        key={field.key}
                        className="border border-border rounded-lg p-4 flex flex-col gap-2 bg-card"
                    >
                        <div className="flex items-center justify-between">
                            <div>
                                <label
                                    htmlFor={`color-${field.key}`}
                                    className="text-sm font-medium text-foreground"
                                >
                                    {field.label}
                                </label>
                                <p className="text-xs text-muted-foreground">{field.description}</p>
                            </div>
                            <div
                                className="w-8 h-8 rounded-md border border-border shrink-0"
                                style={{
                                    backgroundColor: colors[field.key] || "#e5e5e5",
                                }}
                            />
                        </div>
                        <input
                            id={`color-${field.key}`}
                            type="text"
                            placeholder="e.g. oklch(0.53 0.14 150) or #3b82f6"
                            value={colors[field.key] || ""}
                            onChange={(e) => handleChange(field.key, e.target.value)}
                            className="w-full px-3 py-1.5 text-sm rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                    </div>
                ))}
            </div>

            <div className="mt-6 flex items-center gap-3">
                <button
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Save className="h-4 w-4" />
                    )}
                    {saving ? "Saving…" : "Save Changes"}
                </button>

                <button
                    onClick={handleReset}
                    disabled={saving}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    <RotateCcw className="h-4 w-4" />
                    Reset to Defaults
                </button>
            </div>
        </div>
    );
}
