// The browser every UI suite drives: DPI_TEST_BROWSER=chrome (installed Google Chrome, the default),
// chromium or firefox (Playwright's builds: npx playwright install chromium|firefox). HEADED=1 to watch.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium, firefox } = require("@playwright/test");

const choice = process.env.DPI_TEST_BROWSER ?? "chrome";
if (!["chrome", "chromium", "firefox"].includes(choice))
  throw Error(`DPI_TEST_BROWSER must be chrome, chromium or firefox, got "${choice}"`);

// macOS 27 TCC-protects ~/Library/Application Support/Firefox, which Playwright's Firefox shares with an installed
// Firefox, so it exits with "Could not find profile folder". A private home avoids it until Firefox 158 ships in
// Playwright: https://github.com/microsoft/playwright/issues/42768
const firefoxEnv = () =>
  process.platform === "darwin"
    ? { env: { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "dpi-firefox-home-")) } }
    : {};

export const launch = () =>
  choice === "firefox"
    ? firefox.launch({ headless: !process.env.HEADED, ...firefoxEnv() })
    : chromium.launch({ ...(choice === "chrome" ? { channel: "chrome" } : {}), headless: !process.env.HEADED });
