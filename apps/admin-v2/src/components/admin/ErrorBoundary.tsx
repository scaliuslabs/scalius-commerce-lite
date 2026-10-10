import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";

// The fallback loads only when something crashed: no page pays for it up front.
const ErrorState = lazy(() => import("./states/ErrorState").then((module) => ({ default: module.ErrorState })));

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

/** Keeps a crash inside one editor or view from taking down the whole dashboard. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleReset = () => {
    this.setState({ error: null });
    if (this.props.onReset) this.props.onReset();
    else window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback ?? (
      <Suspense fallback={null}>
        <ErrorState error={this.state.error} onRetry={this.handleReset} />
      </Suspense>
    );
  }
}
