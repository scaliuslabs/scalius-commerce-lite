import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@scalius/shared/utils";

/**
 * The panels on screen, by value: a trigger points at its panel (aria-controls)
 * only while that panel exists. Tabs used as a filter over one list have no
 * panels, so their triggers point at nothing rather than at a missing id.
 */
const PanelsContext = React.createContext<{ panels: ReadonlySet<string>; mount: (value: string) => () => void } | null>(null);

const Tabs = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>((props, ref) => {
  const [panels, setPanels] = React.useState<ReadonlySet<string>>(() => new Set());
  const mount = React.useCallback((value: string) => {
    setPanels((current) => new Set(current).add(value));
    return () => setPanels((current) => {
      const next = new Set(current);
      next.delete(value);
      return next;
    });
  }, []);
  const context = React.useMemo(() => ({ panels, mount }), [panels, mount]);
  return (
    <PanelsContext.Provider value={context}>
      <TabsPrimitive.Root ref={ref} {...props} />
    </PanelsContext.Provider>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

/** Polaris tabs: quiet text tabs, the selected one on a neutral fill. */
const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex max-w-full items-center gap-1 overflow-x-auto text-muted-foreground", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const panels = React.useContext(PanelsContext)?.panels;
  const hasPanel = panels?.has(props.value) ?? false;
  return (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-body font-medium hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-secondary data-[state=active]:text-foreground sm:h-8 [&_svg]:size-4",
      className,
    )}
    {...props}
    {...(hasPanel ? {} : { "aria-controls": undefined })}
  />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => {
  const mount = React.useContext(PanelsContext)?.mount;
  // An inactive panel renders no element: it counts only while its element is in the page.
  const unmount = React.useRef<(() => void) | null>(null);
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    unmount.current?.();
    unmount.current = node && mount ? mount(props.value) : null;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [mount, props.value, ref]);
  return (
  <TabsPrimitive.Content
    ref={setRef}
    className={cn("mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
    {...props}
  />
  );
});
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
