import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "../../ui/select";
import type { CheckoutSettingsSection } from "./checkout-settings-sections";
import { useWorkspaceScrollMemory } from "~/hooks/use-workspace-scroll-memory";
import { PanelLoadingSkeleton } from "../shared/LoadingFallback";

const CheckoutFlowSettings = lazy(() =>
    import("./CheckoutFlowSettings")
);
const PaymentGatewaysManager = lazy(() =>
    import("./PaymentGatewaysManager")
);
const CheckoutLanguagesManager = lazy(() =>
    import("../checkout-languages").then((m) => ({
        default: m.CheckoutLanguagesManager,
    }))
);
const ShippingMethodsManager = lazy(() =>
    import("../shipping-methods").then((m) => ({
        default: m.ShippingMethodsManager,
    }))
);
const DeliveryLocationsManager = lazy(() =>
    import("../delivery-locations").then((m) => ({
        default: m.DeliveryLocationsManager,
    }))
);
const CustomerRequestSettings = lazy(() =>
    import("./CustomerRequestSettings")
);

function TabSpinner() {
    return <PanelLoadingSkeleton />;
}

const tabs = [
    { value: "checkout-flow", label: "Checkout flow" },
    { value: "payment", label: "Payment gateways" },
    { value: "languages", label: "Languages" },
    { value: "shipping", label: "Shipping methods" },
    { value: "delivery", label: "Delivery locations" },
    { value: "customer-requests", label: "Customer requests" },
] as const;

interface CheckoutSettingsPageProps {
    section: CheckoutSettingsSection;
    onSectionChange: (section: CheckoutSettingsSection) => void;
}

export function getNearestTabScrollLeft({
    scrollLeft,
    clientWidth,
    scrollWidth,
    tabOffsetLeft,
    tabOffsetWidth,
    edgePadding = 8,
}: {
    scrollLeft: number;
    clientWidth: number;
    scrollWidth: number;
    tabOffsetLeft: number;
    tabOffsetWidth: number;
    edgePadding?: number;
}) {
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    const visibleLeft = scrollLeft + edgePadding;
    const visibleRight = scrollLeft + clientWidth - edgePadding;
    const tabRight = tabOffsetLeft + tabOffsetWidth;

    if (tabOffsetLeft < visibleLeft) {
        return Math.max(0, Math.min(maxScroll, tabOffsetLeft - edgePadding));
    }
    if (tabRight > visibleRight) {
        return Math.max(
            0,
            Math.min(maxScroll, tabRight - clientWidth + edgePadding),
        );
    }
    return scrollLeft;
}

export default function CheckoutSettingsPage({
    section,
    onSectionChange,
}: CheckoutSettingsPageProps) {
    const [mountedTabs, setMountedTabs] = useState<Set<string>>(
        () => new Set([section])
    );
    const tabListRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef(new Map<CheckoutSettingsSection, HTMLButtonElement>());

    useEffect(() => {
        setMountedTabs((prev) => {
            if (prev.has(section)) return prev;
            const next = new Set(prev);
            next.add(section);
            return next;
        });
    }, [section]);

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            const list = tabListRef.current;
            const activeTab = tabRefs.current.get(section);
            if (!list || !activeTab || list.clientWidth === 0) return;
            const nextScrollLeft = getNearestTabScrollLeft({
                scrollLeft: list.scrollLeft,
                clientWidth: list.clientWidth,
                scrollWidth: list.scrollWidth,
                tabOffsetLeft: activeTab.offsetLeft,
                tabOffsetWidth: activeTab.offsetWidth,
            });
            if (nextScrollLeft === list.scrollLeft) return;
            list.scrollTo({
                left: nextScrollLeft,
                behavior: "auto",
            });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [section]);

    const rememberWorkspaceScroll = useWorkspaceScrollMemory(section);
    const handleTabChange = (value: string) => {
        onSectionChange(value as CheckoutSettingsSection);
    };

    return (
        <div
            className="mx-auto max-w-6xl"
            onPointerDownCapture={rememberWorkspaceScroll}
            onKeyDownCapture={rememberWorkspaceScroll}
        >
            <div className="mb-4">
                <h1 className="text-xl font-semibold tracking-tight">
                    Checkout
                </h1>
            </div>

            <Tabs
                value={section}
                onValueChange={handleTabChange}
                className="w-full"
            >
                <div className="mb-4 sm:hidden">
                    <Select value={section} onValueChange={handleTabChange}>
                        <SelectTrigger
                            aria-label="Checkout settings section"
                            className="h-11 w-full bg-card"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {tabs.map((tab) => (
                                <SelectItem
                                    key={tab.value}
                                    value={tab.value}
                                    className="min-h-11"
                                >
                                    {tab.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <TabsList
                    ref={tabListRef}
                    aria-label="Checkout settings sections"
                    className="hidden h-auto w-full scroll-px-3 justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 [scrollbar-width:thin] sm:flex"
                >
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            ref={(element) => {
                                if (element) tabRefs.current.set(tab.value, element);
                                else tabRefs.current.delete(tab.value);
                            }}
                            className="min-h-11 shrink-0 rounded-none border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none hover:text-foreground sm:px-4"
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <div className="mt-6">
                    <TabsContent forceMount value="checkout-flow" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("checkout-flow") || section === "checkout-flow") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CheckoutFlowSettings />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent forceMount value="payment" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("payment") || section === "payment") && (
                            <Suspense fallback={<TabSpinner />}>
                                <PaymentGatewaysManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent forceMount value="languages" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("languages") || section === "languages") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CheckoutLanguagesManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent forceMount value="shipping" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("shipping") || section === "shipping") && (
                            <Suspense fallback={<TabSpinner />}>
                                <ShippingMethodsManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent forceMount value="delivery" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("delivery") || section === "delivery") && (
                            <Suspense fallback={<TabSpinner />}>
                                <DeliveryLocationsManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent forceMount value="customer-requests" className="mt-0 data-[state=inactive]:hidden">
                        {(mountedTabs.has("customer-requests") || section === "customer-requests") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CustomerRequestSettings />
                            </Suspense>
                        )}
                    </TabsContent>
                </div>
            </Tabs>
        </div>
    );
}
