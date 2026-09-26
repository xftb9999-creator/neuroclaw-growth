// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "../ui/Modal.js";
import { I18nProvider } from "../../lib/i18n.js";

function withI18n(ui: React.ReactElement) {
  return <I18nProvider>{ui}</I18nProvider>;
}

describe("Modal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      withI18n(<Modal open={false} title="t" confirmLabel="ok" onConfirm={() => {}} onClose={() => {}} />)
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows title and confirm button; confirm triggers callback", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      withI18n(
        <Modal open title="纭鏍囬" confirmLabel="纭鎵ц" confirmTestId="confirm-x" onConfirm={onConfirm} onClose={() => {}} />
      )
    );
    expect(screen.getByRole("dialog", { name: "纭鏍囬" })).toBeInTheDocument();
    await user.click(screen.getByTestId("confirm-x"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Escape closes via onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(withI18n(<Modal open title="t" confirmLabel="ok" onConfirm={() => {}} onClose={onClose} />));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop click closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(withI18n(<Modal open title="t" confirmLabel="ok" onConfirm={() => {}} onClose={onClose} />));
    await user.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
