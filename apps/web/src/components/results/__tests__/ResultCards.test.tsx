// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContentNoteCard } from "../ContentNoteCard.js";
import { ConversionChatCard } from "../ConversionChatCard.js";
import { ReviewDashboard } from "../ReviewDashboard.js";
import { renderWithProviders } from "../../../test/utils.js";

describe("ContentNoteCard", () => {
  it("renders one card per content angle with a title-score badge", () => {
    const { container } = renderWithProviders(
      <ContentNoteCard
        payload={{
          contentAngles: [
            "开业三天爆单的3个秘密",
            "新手妈妈最想听的选品攻略"
          ],
          channelRecommendations: ["xiaohongshu", "wechat"]
        }}
        input={{}}
      />
    );

    const articles = container.querySelectorAll("article");
    expect(articles.length).toBe(2);
    // 标题力评分徽章存在且为两位数
    for (const article of Array.from(articles)) {
      expect(article.textContent).toMatch(/标题力\s?\d{2}/);
    }
    // 渠道推荐透传
    expect(container.textContent).toContain("xiaohongshu");
  });

  it("returns null when there are no angles", () => {
    const { container } = renderWithProviders(<ContentNoteCard payload={{}} input={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ConversionChatCard", () => {
  it("returns null without a draft", () => {
    const { container } = renderWithProviders(<ConversionChatCard payload={{}} input={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the chat preview with the lead name and a copy button", async () => {
    renderWithProviders(
      <ConversionChatCard
        payload={{ conversionDraft: "您好!专属 VIP 礼包已为您保留" }}
        input={{ targetCustomer: "会员张女士" }}
      />
    );
    const user = userEvent.setup();
    expect(screen.getByText(/VIP 礼包已为您保留/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /复制/ }));
    expect(await screen.findByText(/已复制/)).toBeInTheDocument();
  });
});

describe("ReviewDashboard", () => {
  it("lists metrics and interactive action checkboxes", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewDashboard
        payload={{
          reviewSummary: "本周小红书表现最好",
          nextActions: ["加倍投放爆款选题", "暂停低效渠道"],
            metrics: [
              { name: "线索数", value: "42", delta: "+18%" },
              { name: "转化率", value: "3.1%", delta: "-0.4%" }
            ]
          }}
          input={{
            metrics: [
              { name: "线索数", value: "42", delta: "+18%" },
              { name: "转化率", value: "3.1%", delta: "-0.4%" }
            ]
          }}
      />
    );

    expect(screen.getByText(/本周小红书表现最好/)).toBeInTheDocument();
    expect(screen.getByText(/线索数/)).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    await user.click(boxes[0]);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
  });
});
