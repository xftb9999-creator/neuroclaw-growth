// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ErrorBoundary } from "../ErrorBoundary.js";

function Boom(): never {
  throw new Error("boom-for-test");
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">content</div>
      </ErrorBoundary>
    );
    expect(screen.getByTestId("ok")).toBeInTheDocument();
  });

  it("renders recoverable fallback instead of a blank page on error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/页面出错了/)).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: /刷新页面/ });
    expect(reload).toBeInTheDocument();

    spy.mockRestore();
  });
});
