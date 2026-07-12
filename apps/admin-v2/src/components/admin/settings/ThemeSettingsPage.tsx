import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Loader2, RotateCcw, Save, Palette } from "lucide-react";
import { getThemeSettings, updateThemeSettings } from "@/lib/api-functions/settings";
import { isAdminApiConflictError } from "@/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { usePermissions } from "@/contexts/PermissionContext";

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
    { key: "destructive-foreground", label: "Destructive Foreground", description: "Text on destructive surfaces" },
    { key: "border", label: "Border", description: "Default border color" },
    { key: "input", label: "Input", description: "Input border color" },
    { key: "ring", label: "Ring", description: "Focus ring color" },
] as const;

type ColorKey = (typeof COLOR_FIELDS)[number]["key"];

const PREDEFINED_PALETTES: Record<string, { label: string; colors: Record<string, string>; bg: string }> = {
    Zinc: {
        label: "Zinc (Default)",
        bg: "#18181b",
        colors: {
            "background": "#ffffff",
            "foreground": "#09090b",
            "card": "#ffffff",
            "card-foreground": "#09090b",
            "popover": "#ffffff",
            "popover-foreground": "#09090b",
            "primary": "#18181b",
            "primary-foreground": "#fafafa",
            "secondary": "#f4f4f5",
            "secondary-foreground": "#18181b",
            "muted": "#f4f4f5",
            "muted-foreground": "#71717a",
            "accent": "#f4f4f5",
            "accent-foreground": "#18181b",
            "destructive": "#dc2626",
            "destructive-foreground": "#ffffff",
            "border": "#e4e4e7",
            "input": "#e4e4e7",
            "ring": "#09090b",
        }
    },
    Blue: {
        label: "Ocean Blue",
        bg: "#2563eb",
        colors: {
            "background": "#ffffff",
            "foreground": "#0f172a",
            "card": "#ffffff",
            "card-foreground": "#0f172a",
            "primary": "#2563eb",
            "primary-foreground": "#ffffff",
            "secondary": "#f1f5f9",
            "secondary-foreground": "#0f172a",
            "muted": "#f8fafc",
            "muted-foreground": "#64748b",
            "accent": "#f1f5f9",
            "accent-foreground": "#0f172a",
            "destructive": "#dc2626",
            "destructive-foreground": "#ffffff",
            "border": "#e2e8f0",
            "input": "#e2e8f0",
            "ring": "#2563eb",
        }
    },
    Emerald: {
        label: "Eco Emerald",
        bg: "#10b981",
        colors: {
            "background": "#ffffff",
            "foreground": "#022c22",
            "card": "#ffffff",
            "card-foreground": "#022c22",
            "primary": "#047857",
            "primary-foreground": "#ffffff",
            "secondary": "#ecfdf5",
            "secondary-foreground": "#064e3b",
            "muted": "#f0fdf4",
            "muted-foreground": "#065f46",
            "accent": "#d1fae5",
            "accent-foreground": "#064e3b",
            "destructive": "#b91c1c",
            "destructive-foreground": "#ffffff",
            "border": "#a7f3d0",
            "input": "#a7f3d0",
            "ring": "#047857",
        }
    },
    Rose: {
        label: "Rose Blush",
        bg: "#e11d48",
        colors: {
            "background": "#ffffff",
            "foreground": "#4c0519",
            "card": "#ffffff",
            "card-foreground": "#4c0519",
            "primary": "#be123c",
            "primary-foreground": "#ffffff",
            "secondary": "#ffe4e6",
            "secondary-foreground": "#881337",
            "muted": "#fff1f2",
            "muted-foreground": "#9f1239",
            "accent": "#fecdd3",
            "accent-foreground": "#881337",
            "destructive": "#991b1b",
            "destructive-foreground": "#ffffff",
            "border": "#fecdd3",
            "input": "#fecdd3",
            "ring": "#be123c",
        }
    },
    Midnight: {
        label: "Midnight Dark",
        bg: "#09090b",
        colors: {
            "background": "#09090b",
            "foreground": "#fafafa",
            "card": "#09090b",
            "card-foreground": "#fafafa",
            "primary": "#fafafa",
            "primary-foreground": "#18181b",
            "secondary": "#27272a",
            "secondary-foreground": "#fafafa",
            "muted": "#27272a",
            "muted-foreground": "#a1a1aa",
            "accent": "#27272a",
            "accent-foreground": "#fafafa",
            "destructive": "#7f1d1d",
            "destructive-foreground": "#fafafa",
            "border": "#27272a",
            "input": "#27272a",
            "ring": "#d4d4d8",
        }
    }
};

// Helper to determine if a color is a simple hex for the picker
const isHex = (str: string) => /^#([0-9A-F]{3}){1,2}$/i.test(str);

export default function ThemeSettingsPage() {
    const { hasPermission } = usePermissions();
    const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
    const [colors, setColors] = useState<Record<string, string>>({});
    const [savedColors, setSavedColors] = useState<Record<string, string>>({});
    const [revision, setRevision] = useState(0);
    const [conflict, setConflict] = useState<{ colors: Record<string, string>; revision: number } | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
    const [activePicker, setActivePicker] = useState<string | null>(null);
    const pickerRef = useRef<HTMLDivElement>(null);

    // Close picker when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
                setActivePicker(null);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const fetchColors = useCallback(async () => {
        try {
            setLoading(true);
            const data = await getThemeSettings();
            setColors(data.colors);
            setSavedColors(data.colors);
            setRevision(data.revision);
            setDirty(false);
            setConflict(null);
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
        setActivePicker(null);
    };

    const handleDiscard = () => {
        setColors(savedColors);
        setDirty(false);
        setConflict(null);
        setMessage(null);
        setActivePicker(null);
    };

    const loadConflictingVersion = () => {
        if (!conflict) return;
        setColors(conflict.colors);
        setSavedColors(conflict.colors);
        setRevision(conflict.revision);
        setDirty(false);
        setConflict(null);
        setMessage(null);
    };

    const applyPalette = (paletteName: string) => {
        const palette = PREDEFINED_PALETTES[paletteName];
        if (palette) {
            setColors((prev) => ({ ...prev, ...palette.colors }));
            setDirty(true);
            setMessage(null);
            setActivePicker(null);
        }
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
            const saved = await updateThemeSettings({
                data: { colors: cleaned, expectedRevision: revision },
            });
            setColors(saved.colors);
            setSavedColors(saved.colors);
            setRevision(saved.revision);
            setDirty(false);
            setConflict(null);
            setMessage({ type: "success", text: "Theme published to the storefront." });
        } catch (error) {
            if (isAdminApiConflictError(error)) {
                try {
                    const latest = await getThemeSettings();
                    setRevision(latest.revision);
                    setConflict(latest);
                    setMessage(null);
                } catch {
                    setMessage({ type: "error", text: "The theme changed elsewhere, and the latest version could not be loaded. Reload before publishing." });
                }
            } else {
                setMessage({ type: "error", text: "Theme could not be published. Your draft is still in this tab." });
            }
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
        <div className="mx-auto max-w-7xl pb-24">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                    <Palette className="h-6 w-6" />
                    Storefront Theme
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Choose a palette, then fine-tune only the colors you need. Publishing updates every buyer-facing route.
                </p>
                </div>
                <span className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                    Published revision {revision || "not yet published"}
                </span>
            </div>

            {!canManage && (
                <div className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    You can review the published theme, but your role cannot publish changes.
                </div>
            )}

            {conflict && (
                <div className="mb-4 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                            <p className="font-medium">Another session published revision {conflict.revision}.</p>
                            <p className="text-xs opacity-80">Your draft is preserved. Load the latest theme, or review this draft and publish again to replace it.</p>
                        </div>
                    </div>
                    <button type="button" onClick={loadConflictingVersion} className="shrink-0 rounded-md border border-amber-400 bg-background px-3 py-1.5 text-xs font-medium">
                        Load latest
                    </button>
                </div>
            )}

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

            <div className="flex flex-col gap-4 xl:flex-row">
                {/* Left Column: Form & Palettes */}
                <div className="min-w-0 flex-1 space-y-4">
                    {/* Predefined Palettes */}
                    <div className="border border-border rounded-xl bg-card overflow-hidden">
                        <div className="p-4 border-b border-border bg-muted/30">
                            <h3 className="font-semibold text-foreground">Predefined Palettes</h3>
                            <p className="text-xs text-muted-foreground">Select a complete theme to get started quickly. Presets are tuned for readable contrast on primary/destructive actions.</p>
                        </div>
                        <div className="flex flex-wrap gap-2 p-3">
                            {Object.entries(PREDEFINED_PALETTES).map(([key, palette]) => (
                                <button
                                    key={key}
                                    onClick={() => applyPalette(key)}
                                    disabled={!canManage}
                                    className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <div className="w-5 h-5 rounded-full shadow-inner ring-1 ring-black/10" style={{ backgroundColor: palette.bg }} />
                                    <span className="text-sm font-medium text-foreground">{palette.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Color Fields */}
                    <details className="rounded-xl border bg-card">
                        <summary className="cursor-pointer list-none px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            <h3 className="font-semibold text-foreground">Color Variables</h3>
                            <p className="text-xs text-muted-foreground">Advanced · {Object.keys(colors).length} storefront overrides</p>
                        </summary>
                        <div className="grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-2 lg:grid-cols-3">
                            {COLOR_FIELDS.map((field) => {
                                const val = colors[field.key] || "";
                                const bgColor = val || "#e5e5e5";

                                return (
                                    <div
                                        key={field.key}
                                        className="relative flex flex-col gap-2 rounded-md border border-border bg-background p-3"
                                    >
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <label
                                                    htmlFor={`color-${field.key}`}
                                                    className="text-sm font-medium text-foreground"
                                                >
                                                    {field.label}
                                                </label>
                                                <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{field.description}</p>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setActivePicker(activePicker === field.key ? null : field.key)}
                                                className="w-8 h-8 rounded-md border border-border shrink-0 shadow-inner ring-offset-1 focus:ring-2 ring-primary transition-all"
                                                style={{ backgroundColor: bgColor }}
                                                title="Click to pick color"
                                                disabled={!canManage}
                                            />
                                        </div>
                                        <input
                                            id={`color-${field.key}`}
                                            type="text"
                                            placeholder="e.g. #3b82f6"
                                            value={val}
                                            onChange={(e) => handleChange(field.key, e.target.value)}
                                            disabled={!canManage}
                                            className="w-full px-3 py-1.5 text-xs font-mono rounded-md border border-input bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                        />

                                        {/* Color Picker Popover */}
                                        {activePicker === field.key && (
                                            <div ref={pickerRef} className="absolute z-10 top-full mt-2 right-0 bg-white p-3 rounded-xl shadow-xl border border-border animate-in fade-in zoom-in-95">
                                                <input
                                                    type="color"
                                                    className="w-48 h-48 border-0 p-0 rounded-md cursor-pointer block bg-transparent"
                                                    value={isHex(val) ? val : "#000000"}
                                                    onChange={(e) => handleChange(field.key, e.target.value)}
                                                    disabled={!canManage}
                                                    style={{ WebkitAppearance: 'none' }}
                                                />
                                                <div className="mt-3 flex gap-2">
                                                    <input
                                                        type="text"
                                                        className="flex-1 text-xs border border-input rounded px-2 font-mono bg-background text-foreground"
                                                        value={val}
                                                        onChange={(e) => handleChange(field.key, e.target.value)}
                                                        disabled={!canManage}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </details>
                </div>

                {/* Right Column: Live Preview Sticky */}
                <div className="w-full shrink-0 xl:w-80">
                    <div className="sticky top-24 border border-border rounded-xl bg-card overflow-hidden shadow-sm">
                        <div className="p-3 border-b border-border bg-muted/30">
                            <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
                                <Palette className="w-4 h-4" /> Sample Preview
                            </h3>
                        </div>

                        {/* THE PREVIEW CANVAS */}
                        <div
                            className="p-6 space-y-6"
                            style={{
                                backgroundColor: colors["background"] || "hsl(var(--background))",
                                color: colors["foreground"] || "hsl(var(--foreground))"
                            } as React.CSSProperties}
                        >
                            {/* Dummy Hero */}
                            <div className="text-center space-y-2">
                                <h1 className="text-2xl font-bold tracking-tight">Summer Collection</h1>
                                <p
                                    className="text-sm"
                                    style={{ color: colors["muted-foreground"] || "hsl(var(--muted-foreground))" } as React.CSSProperties}
                                >
                                    Discover the latest trends.
                                </p>
                            </div>

                            {/* Dummy Product Card */}
                            <div
                                className="rounded-xl border shadow-sm p-4 text-left"
                                style={{
                                    backgroundColor: colors["card"] || "hsl(var(--card))",
                                    color: colors["card-foreground"] || "hsl(var(--card-foreground))",
                                    borderColor: colors["border"] || "hsl(var(--border))"
                                } as React.CSSProperties}
                            >
                                <div
                                    className="w-full h-32 rounded-lg mb-3 flex items-center justify-center font-bold"
                                    style={{
                                        backgroundColor: colors["muted"] || "hsl(var(--muted))",
                                        color: colors["muted-foreground"] || "hsl(var(--muted-foreground))"
                                    } as React.CSSProperties}
                                >
                                    Image
                                </div>
                                <h4 className="font-semibold text-sm">Classic T-Shirt</h4>
                                <p className="text-xs mb-3" style={{ color: colors["muted-foreground"] || "hsl(var(--muted-foreground))" } as React.CSSProperties}>High quality cotton</p>
                                <button
                                    className="w-full py-2 rounded-md font-medium text-sm transition-opacity hover:opacity-90"
                                    style={{
                                        backgroundColor: colors["primary"] || "hsl(var(--primary))",
                                        color: colors["primary-foreground"] || "hsl(var(--primary-foreground))"
                                    } as React.CSSProperties}
                                >
                                    Add to Cart
                                </button>
                            </div>

                            {/* Secondary Action */}
                            <button
                                className="w-full py-2 rounded-md font-medium text-sm border transition-colors hover:opacity-90"
                                style={{
                                    backgroundColor: colors["secondary"] || "hsl(var(--secondary))",
                                    color: colors["secondary-foreground"] || "hsl(var(--secondary-foreground))",
                                    borderColor: colors["border"] || "hsl(var(--border))"
                                } as React.CSSProperties}
                            >
                                View Categories
                            </button>

                            {/* Alert Box */}
                            <div
                                className="rounded-lg p-3 text-xs border"
                                style={{
                                    backgroundColor: (colors["destructive"] || "hsl(var(--destructive))") + "1a", // 10% opacity hex hack, works mostly or fallback
                                    color: colors["destructive"] || "hsl(var(--destructive))",
                                    borderColor: (colors["destructive"] || "hsl(var(--destructive))") + "33"
                                } as React.CSSProperties}
                            >
                                <span className="font-bold">Note:</span> Items in cart are not reserved.
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:left-[var(--sidebar-width,0px)]">
              <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{dirty ? "Unpublished changes in this tab" : "Published theme is up to date"}</p>
                <div className="flex items-center gap-2">
                <button
                    onClick={handleSave}
                    disabled={!canManage || saving || !dirty}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    {saving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Save className="h-4 w-4" />
                    )}
                    {saving ? "Publishing…" : "Publish theme"}
                </button>

                <button
                    onClick={handleReset}
                    disabled={!canManage || saving}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md border border-border bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    <RotateCcw className="h-4 w-4" />
                    Use defaults
                </button>
                <button
                    onClick={handleDiscard}
                    disabled={saving || !dirty}
                    className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                    Discard draft
                </button>
                </div>
              </div>
            </div>
        </div>
    );
}
