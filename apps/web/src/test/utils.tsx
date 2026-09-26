import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import { type ReactNode } from "react";

import { I18nProvider } from "../lib/i18n.js";

/** 组合被测组件所需的最小 Provider 栈;i18n 固定 zh-CN 便于断言。 */
export function renderWithProviders(ui: ReactNode, options: Omit<RenderOptions, "wrapper"> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });

  window.localStorage.setItem("neuroclaw.locale", "zh-CN");

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>{children}</I18nProvider>
      </QueryClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper, ...options });
}

export function makeRun(overrides: Partial<import("../types.js").RunRecord> = {}): import("../types.js").RunRecord {
  const now = new Date().toISOString();
  return {
    id: `run_${Math.random().toString(16).slice(2)}`,
    workspaceId: "ws_test",
    templateType: "content_acquisition",
    status: "completed",
    input: {},
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}
