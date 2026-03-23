import React from "react";
import { ErrorBoundary } from "../ErrorBoundary";

interface PageSectionProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onReset?: () => void;
  className?: string;
}

export function PageSection({ children, fallback, onReset, className }: PageSectionProps) {
  return (
    <div className={className}>
      <ErrorBoundary fallback={fallback} onReset={onReset}>
        {children}
      </ErrorBoundary>
    </div>
  );
}
