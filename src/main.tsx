import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: undefined };
  }

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }

  componentDidCatch(error: unknown) {
    console.error("UI crash:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "Segoe UI, sans-serif", color: "#e6edf7", background: "#0b0f16", minHeight: "100vh" }}>
          <h2>Client error</h2>
          <p>The UI crashed. This is a bug. Please send this message:</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#141a24", padding: 12, borderRadius: 8 }}>{this.state.error}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}
