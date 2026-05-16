import fs from "node:fs/promises";
import { chromium } from "playwright";
import { ProviderError } from "../errors.js";

const PROMPT_SELECTORS = [
  "#prompt-textarea",
  "textarea[placeholder*='Message']",
  "textarea",
  "[contenteditable='true']",
];

export class ChatGptImageBrowserWorker {
  constructor({ profileDir, headless = false, timeoutMs = 180000, url = "https://chatgpt.com/" }) {
    this.id = "chatgpt-image-browser";
    this.profileDir = profileDir;
    this.headless = headless;
    this.timeoutMs = timeoutMs;
    this.url = url;
  }

  async health() {
    try {
      await fs.mkdir(this.profileDir, { recursive: true });
      return {
        id: this.id,
        status: "configured",
        capabilities: ["image_generate", "image_edit_experimental"],
        profileDir: this.profileDir,
        headless: this.headless,
      };
    } catch (error) {
      return {
        id: this.id,
        status: "unhealthy",
        error: error.message,
      };
    }
  }

  async generateImage({ prompt }) {
    if (!prompt || typeof prompt !== "string") {
      throw new ProviderError("invalid_request", "Image prompt is required.");
    }

    await fs.mkdir(this.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 1100 },
      acceptDownloads: true,
    });

    try {
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(this.timeoutMs);
      await page.goto(this.url, { waitUntil: "domcontentloaded" });

      const promptTarget = await this.#findPromptTarget(page);
      if (!promptTarget) {
        throw new ProviderError(
          "auth_required",
          "ChatGPT prompt box was not available. Log in with npm run login:chatgpt.",
        );
      }

      const initialImageCount = await page.locator("main img, img").count().catch(() => 0);
      await this.#submitPrompt(promptTarget, prompt);
      const image = await this.#waitForNewImage(page, initialImageCount);
      const extracted = await this.#extractImage(page, image);

      return {
        ...extracted,
        providerMetadata: {
          worker: this.id,
          extraction: extracted.extraction,
          sourceUrl: extracted.sourceUrl || null,
        },
      };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async #findPromptTarget(page) {
    for (const selector of PROMPT_SELECTORS) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return null;
  }

  async #submitPrompt(locator, prompt) {
    await locator.click();
    const tagName = await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tagName === "textarea" || tagName === "input") {
      await locator.fill(prompt);
    } else {
      await locator.evaluate((node) => {
        node.textContent = "";
      });
      await locator.type(prompt, { delay: 1 });
    }
    await locator.press("Enter");
  }

  async #waitForNewImage(page, initialImageCount) {
    await page.waitForFunction(
      (count) => document.querySelectorAll("main img, img").length > count,
      initialImageCount,
      { timeout: this.timeoutMs },
    ).catch(() => {
      throw new ProviderError("image_timeout", "Timed out waiting for ChatGPT to render an image.");
    });

    const images = page.locator("main img, img");
    const count = await images.count();
    return images.nth(count - 1);
  }

  async #extractImage(page, imageLocator) {
    const sourceUrl = await imageLocator.getAttribute("src").catch(() => null);

    if (sourceUrl) {
      const fetched = await page.evaluate(async (src) => {
        try {
          const response = await fetch(src);
          const blob = await response.blob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          const chunkSize = 0x8000;
          for (let index = 0; index < bytes.length; index += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
          }
          return {
            ok: true,
            base64: btoa(binary),
            mimeType: blob.type || "image/png",
          };
        } catch (error) {
          return {
            ok: false,
            error: error.message,
          };
        }
      }, sourceUrl);

      if (fetched?.ok) {
        return {
          bytes: Buffer.from(fetched.base64, "base64"),
          mimeType: fetched.mimeType,
          extraction: "fetch",
          sourceUrl,
        };
      }
    }

    const screenshot = await imageLocator.screenshot({ type: "png" });
    return {
      bytes: screenshot,
      mimeType: "image/png",
      extraction: "element_screenshot",
      sourceUrl,
    };
  }
}
