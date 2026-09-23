import type { AttributeValuesViewerProps } from "../types";
import { AttributeValueEditor } from "./AttributeValueEditor";

/** The values dialog for staff who may look but not change. */
export function AttributeValuesViewer(props: AttributeValuesViewerProps) {
  return <AttributeValueEditor {...props} readOnly />;
}
