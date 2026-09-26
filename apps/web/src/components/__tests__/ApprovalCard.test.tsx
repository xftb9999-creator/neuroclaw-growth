// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApprovalCard } from "../ApprovalCard.js";
import { renderWithProviders as render } from "../../test/utils.js";

function setup(overrides: Partial<Parameters<typeof ApprovalCard>[0]> = {}) {
  const onApprove = vi.fn().mockResolvedValue(undefined);
  const onReject = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <ApprovalCard
      actionType="notification_send_preview"
      reason="High-risk action requires manual approval"
      input={{
        businessSummary: "给老客户发开业福利",
        targetCustomer: "母婴店会员",
        preferredChannels: ["wechat", "sms"]
      }}
      onApprove={onApprove}
      onReject={onReject}
      {...overrides}
    />
  );
  const user = userEvent.setup();
  return { onApprove, onReject, user, ...utils };
}

describe("ApprovalCard", () => {
  it("renders the four trust elements", () => {
    setup();
    expect(screen.getByText(/该步骤会向客户发送消息/)).toBeInTheDocument();
    expect(screen.getByText(/系统判定:/)).toBeInTheDocument();
    expect(screen.getByText("将执行的内容预览")).toBeInTheDocument();
    expect(screen.getByText(/给老客户发开业福利/)).toBeInTheDocument();
    expect(screen.getByText("wechat")).toBeInTheDocument();
    expect(screen.getByText("sms")).toBeInTheDocument();
  });

  it("approve requires modal confirmation before firing callback", async () => {
    const { onApprove, user } = setup();
    await user.click(screen.getByTestId("approve-run"));
    expect(onApprove).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("confirm-approve-run"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("reject requires selecting a reason and passes its label", async () => {
    const { onReject, user } = setup();
    await user.click(screen.getByTestId("reject-run"));

    await user.click(screen.getByRole("radio", { name: "时机不合适" }));
    await user.click(screen.getByTestId("confirm-reject-run"));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject.mock.calls[0][0]).toBe("时机不合适");
  });

  it("degrades humanized reason to default for unknown action types", () => {
    setup({ actionType: "mystery_action" });
    expect(screen.getByText("该步骤需要你的确认后才会继续执行。")).toBeInTheDocument();
  });
});
