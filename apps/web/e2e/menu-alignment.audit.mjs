/**
 * Menu alignment audit.
 *
 * Opens every popup menu we can reach from a live thread and measures the real
 * geometry of its rows: row bounds against the surface, icon column, label
 * start, and row heights. Eyeballing a screenshot cannot tell a 1px drift from
 * a 9px one, so this reports numbers and only then captures the image.
 *
 * Run: node e2e/menu-alignment.audit.mjs
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  openAuthenticatedPage,
  openProject,
  startIsolatedApp,
  stopIsolatedApp,
} from "./harness.mjs";

const OUT_DIR = NodePath.join(import.meta.dirname, "..", ".audit");

/** Pixel slack before a difference counts as a defect. */
const TOLERANCE = 0.5;

/**
 * Measures the open surface's rows. Runs in the page so it can read layout
 * boxes and computed padding together.
 */
const MEASURE = () => {
  const surfaces = [...document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"]')]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => el);
  const surface = surfaces.at(-1);
  if (!surface) return null;

  const surfaceBox = surface.getBoundingClientRect();
  const rows = [
    ...surface.querySelectorAll(
      '[role="menuitem"],[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"]',
    ),
  ];

  const measured = rows.map((row) => {
    const box = row.getBoundingClientRect();
    const style = getComputedStyle(row);

    // First text-bearing node's box: this is what the eye reads as the label
    // column, and it is the thing that drifts when one row has an icon and its
    // neighbour does not.
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let labelBox = null;
    let label = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent || node.textContent.trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0) continue;
      labelBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      label = node.textContent.trim();
      break;
    }

    // Only a *leading* icon shares the label's column: it sits left of the
    // label on the same line. Trailing chevrons and second-line provider marks
    // are not part of the alignment we are auditing.
    let icon = null;
    if (labelBox !== null) {
      const labelCentre = labelBox.y + labelBox.height / 2;
      for (const candidate of row.querySelectorAll("svg")) {
        const rect = candidate.getBoundingClientRect();
        if (rect.width === 0) continue;
        if (rect.x + rect.width > labelBox.x) continue;
        if (Math.abs(rect.y + rect.height / 2 - labelCentre) > labelBox.height) continue;
        icon = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        break;
      }
    }

    return {
      label,
      row: { x: box.x, y: box.y, width: box.width, height: box.height },
      icon,
      labelBox,
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
    };
  });

  return {
    surface: {
      x: surfaceBox.x,
      y: surfaceBox.y,
      width: surfaceBox.width,
      height: surfaceBox.height,
    },
    rows: measured,
  };
};

function analyze(name, measurement) {
  const findings = [];
  if (measurement === null) return { name, rows: 0, findings: ["no open surface found"] };
  const { surface, rows } = measurement;
  if (rows.length === 0) return { name, rows: 0, findings: [] };

  const round = (value) => Math.round(value * 100) / 100;
  const spread = (values) => round(Math.max(...values) - Math.min(...values));

  // Row left edges: every row shares one column inside the surface.
  const leftSpread = spread(rows.map((row) => row.row.x));
  if (leftSpread > TOLERANCE) {
    findings.push(`row left edges vary by ${leftSpread}px`);
  }

  // Label starts: the defect a user actually sees as "ragged text".
  const labelled = rows.filter((row) => row.labelBox !== null);
  if (labelled.length > 1) {
    const labelSpread = spread(labelled.map((row) => row.labelBox.x));
    if (labelSpread > TOLERANCE) {
      const sorted = [...labelled].sort((a, b) => a.labelBox.x - b.labelBox.x);
      findings.push(
        `label start varies by ${labelSpread}px: "${sorted[0].label}" at ${round(sorted[0].labelBox.x)} vs "${sorted.at(-1).label}" at ${round(sorted.at(-1).labelBox.x)}`,
      );
    }
  }

  // Mixed icon/no-icon rows are the usual cause of a ragged label column.
  const withIcon = rows.filter((row) => row.icon !== null);
  if (withIcon.length > 0 && withIcon.length < rows.length) {
    const missing = rows.filter((row) => row.icon === null).map((row) => row.label);
    findings.push(
      `${withIcon.length}/${rows.length} rows carry an icon; without: ${missing.join(", ")}`,
    );
  }
  if (withIcon.length > 1) {
    const iconSpread = spread(withIcon.map((row) => row.icon.x));
    if (iconSpread > TOLERANCE) findings.push(`icon column varies by ${iconSpread}px`);
    const iconSizeSpread = spread(withIcon.map((row) => row.icon.width));
    if (iconSizeSpread > TOLERANCE) findings.push(`icon width varies by ${iconSizeSpread}px`);
  }

  // Rows must stay inside the surface they belong to.
  for (const row of rows) {
    if (
      row.row.x < surface.x - TOLERANCE ||
      row.row.x + row.row.width > surface.x + surface.width + TOLERANCE
    ) {
      findings.push(`row "${row.label}" overflows the surface horizontally`);
    }
  }

  // Vertical rhythm. A row carrying a subtitle is legitimately taller, so this
  // is a prompt to look at the screenshot rather than a defect on its own.
  const heightSpread = spread(rows.map((row) => row.row.height));
  if (heightSpread > 1) {
    findings.push(`row heights vary by ${heightSpread}px (check for an intentional subtitle row)`);
  }

  // A leading icon should sit on its label's optical centre.
  for (const row of withIcon) {
    const labelCentre = row.labelBox.y + row.labelBox.height / 2;
    const iconCentre = row.icon.y + row.icon.height / 2;
    if (Math.abs(labelCentre - iconCentre) > 1.5) {
      findings.push(`icon in "${row.label}" is off-centre by ${round(iconCentre - labelCentre)}px`);
    }
  }

  return { name, rows: rows.length, findings, measurement };
}

async function auditMenu(page, name, open, close) {
  try {
    await open();
  } catch (cause) {
    return { name, rows: 0, findings: [`could not open: ${String(cause).split("\n")[0]}`] };
  }
  await page.waitForTimeout(250);
  const measurement = await page.evaluate(MEASURE);
  const result = analyze(name, measurement);
  await page
    .screenshot({ path: NodePath.join(OUT_DIR, `${name.replaceAll(/[^a-z0-9]+/gi, "-")}.png`) })
    .catch(() => {});
  if (close) await close().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(150);
  return result;
}

const app = await startIsolatedApp();
let browser;
try {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  const opened = await openAuthenticatedPage(app);
  browser = opened.browser;
  const { page } = opened;
  await openProject(page, app.workspace);

  const results = [];

  results.push(
    await auditMenu(page, "thread header add panel surface", async () => {
      await page
        .getByRole("button", { name: /add panel surface/i })
        .first()
        .click();
    }),
  );

  results.push(
    await auditMenu(page, "composer workflows", async () => {
      await page
        .getByRole("button", { name: /workflow/i })
        .first()
        .click();
    }),
  );

  results.push(
    await auditMenu(page, "composer model picker", async () => {
      await page.getByRole("button", { name: /model/i }).first().click();
    }),
  );

  results.push(
    await auditMenu(page, "sidebar project menu", async () => {
      await page
        .getByRole("button", { name: /project (options|menu|actions)/i })
        .first()
        .click();
    }),
  );

  results.push(
    await auditMenu(page, "command palette", async () => {
      await page.keyboard.press("Control+k");
    }),
  );

  // Every trigger the page advertises, so nothing is audited only because we
  // happened to name it above.
  const triggers = await page
    .locator(
      'button[aria-haspopup="menu"], button[aria-haspopup="listbox"], button[aria-haspopup="dialog"]',
    )
    .evaluateAll((els) =>
      els.map((el, index) => ({
        index,
        name:
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 40) ??
          `trigger-${index}`,
      })),
    );

  for (const trigger of triggers) {
    results.push(
      await auditMenu(page, `auto: ${trigger.name}`, async () => {
        await page
          .locator(
            'button[aria-haspopup="menu"], button[aria-haspopup="listbox"], button[aria-haspopup="dialog"]',
          )
          .nth(trigger.index)
          .click({ timeout: 5_000 });
      }),
    );
  }

  NodeFS.writeFileSync(
    NodePath.join(OUT_DIR, "menu-alignment.json"),
    JSON.stringify(results, null, 2),
  );

  for (const result of results) {
    const status = result.findings.length === 0 ? "OK  " : "FLAG";
    console.log(`${status} ${result.name} (${result.rows} rows)`);
    for (const finding of result.findings) console.log(`       - ${finding}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopIsolatedApp(app);
}
