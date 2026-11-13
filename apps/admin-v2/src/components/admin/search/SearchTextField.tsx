import type { ComponentProps } from "react";
import { Field } from "~/components/ui/field";
import { useSearchTextLimitHelp } from "./search-text-limit";

/**
 * A rich-text field (description, page content): the one Field, with a help
 * line once its text runs past what search reads.
 */
export function SearchTextField({ html, ...props }: ComponentProps<typeof Field> & { html: string | null | undefined }) {
  const help = useSearchTextLimitHelp(html);
  return <Field {...props} help={props.help ?? help} />;
}
