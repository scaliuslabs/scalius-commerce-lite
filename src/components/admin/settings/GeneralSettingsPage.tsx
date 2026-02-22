import { useState, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { SeoSettingsBuilder } from "../SeoSettingsBuilder";
import { StorefrontUrlBuilder } from "../StorefrontUrlBuilder";
import { SecuritySettingsBuilder } from "../SecuritySettingsBuilder";
import EmailSettingsForm from "./EmailSettingsForm";
import AuthSettingsBuilder from "./AuthSettingsBuilder";
import { Loader2 } from "lucide-react";
import type { HeaderConfig } from "../header-builder/types";
import type { FooterConfig } from "../footer-builder/types";

const HeaderBuilder = lazy(() =>
    import("../header-builder").then((m) => ({
        default: m.HeaderBuilder,
    }))
);
const FooterBuilder = lazy(() =>
    import("../footer-builder").then((m) => ({
        default: m.FooterBuilder,
    }))
);

function TabSpinner() {
    return (
        <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
    );
}

interface GeneralSettingsPageProps {
    headerConfig?: HeaderConfig | null;
    footerConfig?: FooterConfig | null;
}

const tabs = [
    { value: "header", label: "Header" },
    { value: "footer", label: "Footer" },
    { value: "seo", label: "SEO" },
    { value: "storefront", label: "Storefront" },
    { value: "email", label: "Email" },
    { value: "auth", label: "Auth & Access" },
    { value: "security", label: "Security" },
] as const;

export default function GeneralSettingsPage({
    headerConfig,
    footerConfig,
}: GeneralSettingsPageProps) {
    const [activeTab, setActiveTab] = useState("header");
    const [mountedTabs, setMountedTabs] = useState<Set<string>>(
        () => new Set(["header"])
    );

    const handleTabChange = (value: string) => {
        setActiveTab(value);
        setMountedTabs((prev) => {
            if (prev.has(value)) return prev;
            const next = new Set(prev);
            next.add(value);
            return next;
        });
    };

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight">General Settings</h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Appearance, SEO, storefront, email delivery, authentication, and
                    security.
                </p>
            </div>

            <Tabs
                value={activeTab}
                onValueChange={handleTabChange}
                className="w-full"
            >
                <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent p-0 h-auto flex-wrap gap-0">
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground"
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <div className="mt-6">
                    <TabsContent value="header" className="mt-0">
                        {mountedTabs.has("header") && (
                            <Suspense fallback={<TabSpinner />}>
                                <HeaderBuilder initialConfig={headerConfig} />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="footer" className="mt-0">
                        {mountedTabs.has("footer") && (
                            <Suspense fallback={<TabSpinner />}>
                                <FooterBuilder initialConfig={footerConfig} />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="seo" className="mt-0">
                        {mountedTabs.has("seo") && <SeoSettingsBuilder />}
                    </TabsContent>

                    <TabsContent value="storefront" className="mt-0">
                        {mountedTabs.has("storefront") && <StorefrontUrlBuilder />}
                    </TabsContent>

                    <TabsContent value="email" className="mt-0">
                        {mountedTabs.has("email") && <EmailSettingsForm />}
                    </TabsContent>

                    <TabsContent value="auth" className="mt-0">
                        {mountedTabs.has("auth") && <AuthSettingsBuilder />}
                    </TabsContent>

                    <TabsContent value="security" className="mt-0">
                        {mountedTabs.has("security") && <SecuritySettingsBuilder />}
                    </TabsContent>
                </div>
            </Tabs>
        </div>
    );
}
