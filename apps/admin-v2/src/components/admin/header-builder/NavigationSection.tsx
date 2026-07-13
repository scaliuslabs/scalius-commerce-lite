// src/components/admin/header-builder/NavigationSection.tsx
import { NavigationBuilder } from "../navigation/NavigationBuilder";
import type { NavigationItem } from "./types";

interface NavigationSectionProps {
  editorEpoch: number;
  navigation: NavigationItem[];
  onChange: (navigation: NavigationItem[]) => void;
  getStorefrontPath: (path: string) => string;
}

export function NavigationSection({
  editorEpoch,
  navigation,
  onChange,
  getStorefrontPath,
}: NavigationSectionProps) {
  return (
    <NavigationBuilder
      key={editorEpoch}
      navigation={navigation}
      onChange={onChange}
      getStorefrontPath={getStorefrontPath}
    />
  );
}
