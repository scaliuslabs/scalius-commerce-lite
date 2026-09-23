export interface AttributeValue {
  value: string;
  productCount: number;
  sampleProducts: string[];
  isPreset?: boolean;
}

export interface AttributeValuesViewerProps {
  attributeId: string | null;
  attributeName: string | null;
  onClose: () => void;
  openerRef: React.RefObject<HTMLElement | null>;
}
