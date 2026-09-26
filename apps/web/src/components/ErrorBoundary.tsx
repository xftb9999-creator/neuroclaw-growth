import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 防白屏兜底(audit P1-15):渲染异常时给出可恢复界面而非整站崩溃。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            margin: "48px auto",
            maxWidth: 520,
            padding: 24,
            border: "1px solid #e5ddd2",
            borderRadius: 16,
            background: "#fffdf9"
          }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>页面出错了</h1>
          <p style={{ color: "#6f665e", fontSize: 14, margin: "0 0 16px" }}>
            界面渲染发生异常,你的数据不受影响。刷新后即可继续使用。
          </p>
          <pre style={{ fontSize: 12, overflow: "auto", maxHeight: 120 }}>{String(this.state.error.message)}</pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 12,
              padding: "8px 16px",
              borderRadius: 999,
              border: "none",
              background: "#bd4f22",
              color: "#fff",
              cursor: "pointer"
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
