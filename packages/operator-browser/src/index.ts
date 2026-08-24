import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedPage {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  textContent: string;
  headings: { level: number; text: string }[];
  links: { href: string; text: string }[];
  meta: Record<string, string>;
  screenshotBase64?: string;
  extractedAt: string;
}

export interface BrowserAction {
  type: "navigate" | "click" | "fill" | "scroll" | "screenshot" | "extract";
  selector?: string;
  value?: string;
  url?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface OperatorBrowserOptions {
  headless?: boolean;
  timeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

// ---------------------------------------------------------------------------
// OperatorBrowser — real Playwright-backed browser automation
// ---------------------------------------------------------------------------

export class OperatorBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly options: Required<OperatorBrowserOptions>;

  constructor(options: OperatorBrowserOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      timeout: options.timeout ?? 30_000,
      userAgent: options.userAgent ?? "NeuroClaw-Operator/1.0",
      viewport: options.viewport ?? { width: 1280, height: 720 }
    };
  }

  async launch(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({
      userAgent: this.options.userAgent,
      viewport: this.options.viewport
    });
    this.context.setDefaultTimeout(this.options.timeout);
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async extract(
    url: string,
    opts: { screenshot?: boolean; maxTextLength?: number } = {}
  ): Promise<ExtractedPage> {
    await this.launch();
    const page = await this.context!.newPage();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      const title = await page.title();
      const description = await page
        .locator('meta[name="description"]')
        .getAttribute("content")
        .catch(() => null);

      const headingsRaw = await page
        .locator("h1, h2, h3")
        .evaluateAll((els) =>
          els.map((el) => ({
            level: Number(el.tagName.substring(1)),
            text: el.textContent?.trim() ?? ""
          }))
        )
        .catch(() => []);

      const linksRaw = await page
        .locator("a[href]")
        .evaluateAll((els, max) =>
          els
            .slice(0, max)
            .map((el) => ({
              href: (el as HTMLAnchorElement).href,
              text: el.textContent?.trim() ?? ""
            }))
            .filter((l) => l.href && l.text),
          50
        )
        .catch(() => []);

      const metaRaw = await page
        .locator("meta")
        .evaluateAll((els) =>
          els
            .map((el) => ({
              name: el.getAttribute("name") ?? el.getAttribute("property") ?? "",
              content: el.getAttribute("content") ?? ""
            }))
            .filter((m) => m.name && m.content)
        )
        .catch(() => []);

      const meta: Record<string, string> = {};
      for (const m of metaRaw) {
        meta[m.name] = m.content;
      }

      let textContent = await page
        .locator("body")
        .innerText()
        .catch(() => "");

      const maxLen = opts.maxTextLength ?? 10_000;
      if (textContent.length > maxLen) {
        textContent = textContent.substring(0, maxLen) + "\n... [truncated]";
      }

      let screenshotBase64: string | undefined;
      if (opts.screenshot) {
        const buf = await page.screenshot({ fullPage: false, type: "png" }).catch(() => null);
        if (buf) {
          screenshotBase64 = buf.toString("base64");
        }
      }

      return {
        url,
        finalUrl: page.url(),
        title,
        description: description ?? "",
        textContent,
        headings: headingsRaw,
        links: linksRaw,
        meta,
        screenshotBase64,
        extractedAt: new Date().toISOString()
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async executeActions(url: string, actions: BrowserAction[]): Promise<ActionResult[]> {
    await this.launch();
    const page = await this.context!.newPage();
    const results: ActionResult[] = [];

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      for (const action of actions) {
        try {
          switch (action.type) {
            case "navigate":
              if (action.url) {
                await page.goto(action.url, { waitUntil: "domcontentloaded" });
                results.push({ ok: true, message: `Navigated to ${action.url}` });
              }
              break;
            case "click":
              if (action.selector) {
                await page.locator(action.selector).click();
                results.push({ ok: true, message: `Clicked ${action.selector}` });
              }
              break;
            case "fill":
              if (action.selector && action.value !== undefined) {
                await page.locator(action.selector).fill(action.value);
                results.push({ ok: true, message: `Filled ${action.selector}` });
              }
              break;
            case "scroll":
              await page.mouse.wheel(0, 800);
              results.push({ ok: true, message: "Scrolled down" });
              break;
            case "screenshot": {
              const buf = await page.screenshot({ type: "png" });
              results.push({
                ok: true,
                message: "Screenshot captured",
                data: buf.toString("base64")
              });
              break;
            }
            case "extract": {
              const extracted = await this.extract(page.url());
              results.push({ ok: true, message: "Page extracted", data: extracted });
              break;
            }
            default:
              results.push({ ok: false, message: `Unknown action type: ${action.type}` });
          }
        } catch (error) {
          results.push({
            ok: false,
            message: `Action ${action.type} failed: ${error instanceof Error ? error.message : "unknown"}`
          });
        }
      }

      return results;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let singleton: OperatorBrowser | null = null;

export function getOperatorBrowser(options?: OperatorBrowserOptions): OperatorBrowser {
  if (!singleton) {
    singleton = new OperatorBrowser(options);
  }
  return singleton;
}

export async function closeOperatorBrowser(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

export function isBrowserAvailable(): boolean {
  return process.env.NEUROCLAW_BROWSER_DISABLED !== "1";
}
