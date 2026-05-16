import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
await fs.mkdir(config.chatgpt.profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(config.chatgpt.profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1100 },
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(config.chatgpt.url, { waitUntil: "domcontentloaded" });

const readline = createInterface({ input, output });
await readline.question(
  `Log in to ChatGPT in the opened browser. When the prompt box is usable, press Enter here.\nProfile: ${config.chatgpt.profileDir}\n`,
);
readline.close();
await context.close();
