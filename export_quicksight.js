/**
 * Logs into an AWS QuickSight dashboard, finds the "user detail" table,
 * and exports/downloads it as an Excel file.
 *
 * Setup (one-time):
 *   npm install
 *   npx playwright install chromium
 *
 * Usage (cmd.exe):
 *   set QS_USERNAME=your-username
 *   set QS_PASSWORD=your-password
 *   node export_quicksight.js --headed
 *
 * Usage (bash):
 *   QS_USERNAME=your-username QS_PASSWORD=your-password node export_quicksight.js --headed
 *
 * Optional flags:
 *   --url <dashboard-url>   override the default dashboard URL
 *   --sheet-name <text>     sheet/tab to switch to before searching (default: "Registration Details")
 *   --table-name <text>     override the table name to look for (default: "Uer Details")
 *   --out-dir <path>        where to save the downloaded file (default: ./downloads)
 *   --headed                show the browser window instead of running headless
 *   --timeout-ms <int>      per-step timeout in milliseconds (default: 20000)
 *   --no-email              skip sending the result email even if SMTP_* env vars are set
 *
 * Email delivery (optional): set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_TO
 * (SMTP_PORT defaults to 587) to have the downloaded file emailed after export.
 *
 * If a step can't find what it expects, the script saves a screenshot and the
 * page HTML into ./debug/ so selectors can be adjusted without re-running blind.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_URL =
  "https://ap-south-1.quicksight.aws.amazon.com/sn/account/shpf-in-farmrise-analytics" +
  "/dashboards/63bd0601-26e9-4bfa-ab23-741db24b93d5" +
  "/views/8ecd3e5f-4a02-4a76-ad4e-43578d227149";

const DEBUG_DIR = path.join(__dirname, "debug");

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    sheetName: "Registration Details",
    tableName: "Uer Details",
    outDir: path.join(__dirname, "downloads"),
    headed: false,
    timeoutMs: 20000,
    sendEmail: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--sheet-name") args.sheetName = argv[++i];
    else if (a === "--table-name") args.tableName = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--timeout-ms") args.timeoutMs = parseInt(argv[++i], 10);
    else if (a === "--no-email") args.sendEmail = false;
  }
  return args;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function dumpDebug(page, label) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const stamp = timestamp();
  const pngPath = path.join(DEBUG_DIR, `${stamp}-${label}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${stamp}-${label}.html`);
  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch (e) {
    console.log(`  (could not capture screenshot: ${e.message})`);
  }
  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf-8");
  } catch (e) {
    console.log(`  (could not capture html: ${e.message})`);
  }
  console.log(`  Saved debug artifacts: ${path.basename(pngPath)}, ${path.basename(htmlPath)}`);
}

async function login(page, username, password, timeout) {
  // Step 1: QuickSight's own sign-in screen just asks for the account username,
  // then redirects to AWS's unified sign-in page for the password.
  console.log("Waiting for username field...");
  const usernameField = page.locator("#username-input");
  try {
    await usernameField.waitFor({ state: "visible", timeout });
  } catch {
    await dumpDebug(page, "no-username-field");
    throw new Error(
      "Could not find #username-input on the sign-in page. The login flow may have changed " +
        "— check debug/ screenshot."
    );
  }
  await usernameField.fill(username);
  await page.locator("#username-submit-button").click({ timeout });

  // Step 2: AWS sign-in page (ap-south-1.signin.aws) renders a password field
  // via a JS widget, so it can take a few seconds to appear after the redirect.
  console.log("Waiting for password field on AWS sign-in page...");
  const passwordField = page.locator("input[type='password']").first();
  try {
    await passwordField.waitFor({ state: "visible", timeout: Math.max(timeout, 15000) });
  } catch {
    await dumpDebug(page, "no-password-field");
    throw new Error(
      "Could not find a password field on the AWS sign-in page. Check debug/ screenshot — " +
        "the page may not have finished redirecting/rendering yet."
    );
  }
  await passwordField.fill(password);

  await page.getByRole("button", { name: "Sign in", exact: true }).click({ timeout });

  console.log("Submitted login form, waiting for dashboard to load...");
}

async function switchToSheet(page, sheetName, timeout) {
  if (!sheetName) return;
  const tab = page.getByText(sheetName, { exact: true }).first();

  // Sheet tabs can still be rendering right after the initial page load, so a
  // single immediate count() check can race ahead of them and wrongly conclude
  // the tab doesn't exist, silently leaving whatever sheet happened to load
  // (e.g. the user's last-viewed sheet) active instead of switching to it.
  const deadline = Date.now() + Math.max(timeout, 10000);
  let found = false;
  while (Date.now() < deadline) {
    if ((await tab.count()) > 0) {
      found = true;
      break;
    }
    await page.waitForTimeout(500);
  }

  if (!found) {
    await dumpDebug(page, "sheet-tab-not-found");
    throw new Error(
      `Could not find sheet tab '${sheetName}' after waiting. The dashboard may still be ` +
        "loading, or the sheet name may be wrong. Check debug/ screenshot."
    );
  }

  await tab.click({ force: true, timeout });
}

async function findTableContainer(page, tableName, timeout) {
  const pattern = new RegExp(tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const titleLocator = page.getByText(pattern).first();

  // QuickSight lazy-loads visuals as the sheet's inner scroll container grows,
  // so the table title may not exist in the DOM yet even well after page load.
  const maxAttempts = 20;
  let found = false;
  for (let i = 0; i < maxAttempts; i++) {
    if ((await titleLocator.count()) > 0 && (await titleLocator.isVisible())) {
      found = true;
      break;
    }
    await page.evaluate(() => {
      const el = document.querySelector(".scrollable-sheet-view");
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(2000);
  }

  if (!found) {
    await dumpDebug(page, "table-title-not-found");
    throw new Error(
      `Could not find any element with text matching '${tableName}' on the dashboard after ` +
        `scrolling through the sheet. The table may be named differently, on a different sheet, ` +
        "or still loading. Check debug/ screenshot."
    );
  }

  await titleLocator.scrollIntoViewIfNeeded({ timeout });
  await page.waitForTimeout(500);

  let container = titleLocator.locator(
    "xpath=ancestor::*[contains(@class,'visual') or contains(@data-testid,'visual')][1]"
  );
  if ((await container.count()) === 0) {
    container = titleLocator.locator("xpath=ancestor::div[3]");
  }
  return container.first();
}

async function openExportMenu(page, container, timeout) {
  await container.hover({ timeout });
  await page.waitForTimeout(500);

  const menuButtonSelectors = [
    "button[aria-label='More options']",
    "button[aria-label*='options' i]",
    "button[data-testid*='overflow' i]",
    "button[title*='more' i]",
    "[role='button'][aria-label*='more' i]",
  ];

  let menuButton = null;
  for (const sel of menuButtonSelectors) {
    const loc = container.locator(sel).first();
    if ((await loc.count()) > 0) {
      menuButton = loc;
      break;
    }
  }

  // Fallback: the toolbar can render as a page-level overlay rather than nested
  // inside the visual container, so selector-based lookups above may find nothing.
  // Instead, find all buttons positioned along the visual's top edge and take the
  // rightmost one — QuickSight consistently puts the "more options" (⋮) button
  // last/rightmost in that toolbar.
  if (!menuButton) {
    const box = await container.boundingBox();
    if (box) {
      const candidates = await page.evaluate((box) => {
        return Array.from(document.querySelectorAll("button"))
          .map((b) => {
            const r = b.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          })
          .filter(
            (r) => r.w > 0 && r.h > 0 && r.y >= box.y - 10 && r.y <= box.y + 50 && r.x >= box.x && r.x <= box.x + box.width
          )
          .sort((a, b) => b.x - a.x);
      }, box);

      if (candidates.length > 0) {
        const target = candidates[0];
        const cx = target.x + target.w / 2;
        const cy = target.y + target.h / 2;
        await page.mouse.click(cx, cy);
        console.log("Opened the visual's options menu (position-based fallback).");
        return;
      }
    }

    await dumpDebug(page, "no-menu-button");
    throw new Error(
      "Could not find the triple-dot / more-options button on the table's toolbar. " +
        "Check debug/ screenshot — the hover toolbar may need a different selector."
    );
  }

  await menuButton.click({ timeout });
  console.log("Opened the visual's options menu.");
}

// The page contains hidden feature-flag/metadata elements whose text happens to
// match our search regexes (e.g. a hidden div with the flag name
// "qbs_capability_exporttoexcel", which matches /export.*excel/i). page.getByText()
// matches in DOM order regardless of visibility, so a plain .first() can lock onto
// one of these hidden elements and wait forever for it to become visible. Scan all
// matches and only consider ones that are actually visible/clickable.
async function findFirstVisibleByText(page, regex, timeout) {
  const locator = page.getByText(regex);
  const deadline = Date.now() + timeout;
  do {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible()) return candidate;
    }
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return null;
}

async function clickExportToExcel(page, timeout) {
  const directItem = await findFirstVisibleByText(page, /export.*excel/i, timeout);
  if (directItem) {
    await directItem.click({ timeout });
    return;
  }

  const exportParent = await findFirstVisibleByText(page, /^export to$/i, timeout);
  if (exportParent) {
    await exportParent.hover({ timeout });
    const excelItem = await findFirstVisibleByText(page, /excel/i, timeout);
    if (!excelItem) {
      await dumpDebug(page, "no-excel-submenu-item");
      throw new Error(
        "Found 'Export to' but no visible 'Excel' submenu item appeared after hovering. " +
          "Check debug/ screenshot."
      );
    }
    await excelItem.click({ timeout });
    return;
  }

  await dumpDebug(page, "no-export-excel-item");
  throw new Error(
    "Could not find a visible 'Export to Excel' menu item. Check debug/ screenshot " +
      "to see what the open menu actually contains."
  );
}

async function sendEmail(filePath) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_TO } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    console.log("SMTP_USER/SMTP_PASS/MAIL_TO not set — skipping email delivery.");
    return;
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST || "smtp.office365.com",
    port: SMTP_PORT ? parseInt(SMTP_PORT, 10) : 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: SMTP_USER,
    to: MAIL_TO,
    subject: `QuickSight Uer Details export — ${new Date().toISOString().slice(0, 10)}`,
    text: "Attached is today's automated export of the Uer Details table from QuickSight.",
    attachments: [{ path: filePath }],
  });

  console.log(`Emailed export to ${MAIL_TO}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const username = process.env.QS_USERNAME;
  const password = process.env.QS_PASSWORD;
  if (!username || !password) {
    console.error("ERROR: set QS_USERNAME and QS_PASSWORD environment variables before running.");
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);

  try {
    console.log(`Opening ${args.url}`);
    await page.goto(args.url, { waitUntil: "domcontentloaded" });

    await login(page, username, password, args.timeoutMs);

    try {
      await page.waitForLoadState("networkidle", { timeout: args.timeoutMs * 2 });
    } catch {
      console.log("networkidle timed out, continuing anyway");
    }
    // Give the dashboard's visuals time to start lazy-loading before we look for anything.
    await page.waitForTimeout(15000);

    await switchToSheet(page, args.sheetName, args.timeoutMs);
    await page.waitForTimeout(3000);

    console.log(`Looking for table '${args.tableName}'...`);
    const container = await findTableContainer(page, args.tableName, args.timeoutMs);

    await openExportMenu(page, container, args.timeoutMs);

    console.log("Clicking Export to Excel...");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: args.timeoutMs * 2 }),
      clickExportToExcel(page, args.timeoutMs),
    ]);

    const dest = path.join(args.outDir, download.suggestedFilename());
    await download.saveAs(dest);
    console.log(`Saved export to: ${dest}`);

    if (args.sendEmail) {
      await sendEmail(dest);
    }
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    await dumpDebug(page, "failure");
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main();
