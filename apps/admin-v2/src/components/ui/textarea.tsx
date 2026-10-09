import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { useFieldControl } from "./field-context";
import { fieldClassName } from "./input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...rest }, ref) => {
  const props = useFieldControl(rest);
  return <textarea className={cn(fieldClassName, "flex min-h-20 py-2", className)} ref={ref} {...props} />;
});
Textarea.displayName = "Textarea";

export { Textarea };
