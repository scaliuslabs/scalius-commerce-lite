import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@scalius/shared/utils";
import { OVERLAY_COLLISION_PADDING } from "./overlay";

/** The trigger's element, so the open popover can take its name from it. */
const PopoverTriggerContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null);

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const trigger = React.useRef<HTMLElement | null>(null);
  return (
    <PopoverTriggerContext.Provider value={trigger}>
      <PopoverPrimitive.Root data-slot="popover" {...props} />
    </PopoverTriggerContext.Provider>
  );
}

function PopoverTrigger({ ref, ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  const trigger = React.useContext(PopoverTriggerContext);
  const id = React.useId();
  const setRef = React.useCallback((node: HTMLButtonElement | null) => {
    if (trigger) trigger.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref, trigger]);
  // The id lets the content be named after the trigger; a child's own id wins.
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" id={id} ref={setRef} {...props} />;
}

type PopoverName = { "aria-label"?: string; "aria-labelledby"?: string };

/**
 * Radix renders the content as an unnamed `dialog`; it takes the name of the
 * control that opened it: the trigger's own label (aria-labelledby,
 * aria-label or a `<label for>`), else the trigger itself ("Date: Any date").
 * A combobox trigger is never the name, as its name would be its value.
 */
function nameFromTrigger(trigger: HTMLElement | null): PopoverName {
  if (!trigger) return {};
  const labelledBy = trigger.getAttribute("aria-labelledby");
  if (labelledBy) return { "aria-labelledby": labelledBy };
  const label = trigger.getAttribute("aria-label");
  if (label) return { "aria-label": label };
  const text = Array.from((trigger as HTMLButtonElement).labels ?? [], (element) => element.textContent?.trim())
    .filter(Boolean)
    .join(" ");
  if (text) return { "aria-label": text };
  if (trigger.getAttribute("role") === "combobox" || !trigger.id) return {};
  return { "aria-labelledby": trigger.id };
}

function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  collisionPadding = OVERLAY_COLLISION_PADDING,
  sticky = "partial",
  avoidCollisions = true,
  ref,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const trigger = React.useContext(PopoverTriggerContext);
  const named = Boolean(props["aria-label"] || props["aria-labelledby"]);
  const [name, setName] = React.useState<PopoverName>({});
  // Read when the content mounts (each time it opens), after the trigger has.
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node && !named) {
      const next = nameFromTrigger(trigger?.current ?? null);
      setName((current) => (
        current["aria-label"] === next["aria-label"] && current["aria-labelledby"] === next["aria-labelledby"]
          ? current
          : next
      ));
    }
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [named, ref, trigger]);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={setRef}
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        sticky={sticky}
        avoidCollisions={avoidCollisions}
        className={cn(
          "z-50 max-h-[min(24rem,var(--radix-popover-content-available-height))] w-72 overflow-y-auto rounded-xl bg-popover p-4 text-popover-foreground shadow-popover outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible",
          className,
        )}
        {...(named ? {} : name)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
