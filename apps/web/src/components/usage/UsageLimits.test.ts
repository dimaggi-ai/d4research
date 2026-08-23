import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@d4research/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLimitReset,
  selectProviderLimitWindows,
  UsageLimitsView,
  type ProviderLimitWindow,
} from "./UsageLimits";

function provider(
  input: { readonly id: string } & Omit<Partial<ServerProvider>, "instanceId" | "driver">,
): ServerProvider {
  const { id, ...overrides } = input;
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-11T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("selectProviderLimitWindows", () => {
  it("flattens every reported window and keeps the provider identity", () => {
    const rows = selectProviderLimitWindows([
      provider({
        id: "claude",
        displayName: "Claude Code",
        usage: {
          support: "supported",
          planType: "Max",
          limitReached: null,
          checkedAt: "2026-08-11T00:00:00.000Z",
          message: null,
          windows: [
            {
              id: "5h",
              label: "5 hour",
              utilizationPercent: 42,
              resetsAt: "2026-08-11T18:00:00.000Z",
              windowMinutes: 300,
            },
            {
              id: "weekly",
              label: "Weekly",
              utilizationPercent: null,
              resetsAt: null,
              windowMinutes: 10080,
            },
          ],
        },
      }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["claude:5h", "claude:weekly"]);
    expect(rows[0]?.providerLabel).toBe("Claude Code");
    expect(rows[0]?.providerKind).toBe("claude");
    expect(rows[0]?.planType).toBe("Max");
  });

  it("drops providers that never reported usage", () => {
    expect(
      selectProviderLimitWindows([
        provider({ id: "cursor" }),
        provider({
          id: "codex",
          usage: {
            support: "unauthenticated",
            planType: null,
            limitReached: null,
            checkedAt: "2026-08-11T00:00:00.000Z",
            message: null,
            windows: [],
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("leaves the chart colour unset for providers the usage charts do not cover", () => {
    const [row] = selectProviderLimitWindows([
      provider({
        id: "grok",
        usage: {
          support: "supported",
          planType: null,
          limitReached: null,
          checkedAt: "2026-08-11T00:00:00.000Z",
          message: null,
          windows: [
            {
              id: "daily",
              label: "Daily",
              utilizationPercent: 10,
              resetsAt: null,
              windowMinutes: 1440,
            },
          ],
        },
      }),
    ]);

    expect(row?.providerKind).toBeNull();
    expect(row?.providerLabel).toBe("grok");
  });
});

describe("formatLimitReset", () => {
  it("prefixes the plan when the provider names one", () => {
    expect(formatLimitReset("2026-08-11T18:00:00.000Z", "Max")).toMatch(/^Max · Resets /);
  });

  it("says so when the reset stamp is missing or unparseable", () => {
    expect(formatLimitReset(null, null)).toBe("Reset time unavailable");
    expect(formatLimitReset("not-a-date", null)).toBe("Reset time unavailable");
  });
});

function row(overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow {
  return {
    key: "claude:5h",
    providerLabel: "Claude Code",
    providerKind: "claude",
    planType: "Max",
    window: {
      id: "5h",
      label: "5 hour",
      utilizationPercent: 42,
      resetsAt: "2026-08-11T18:00:00.000Z",
      windowMinutes: 300,
    },
    ...overrides,
  };
}

describe("UsageLimitsView", () => {
  it("renders a window with its provider, plan and utilization", () => {
    const markup = renderToStaticMarkup(createElement(UsageLimitsView, { rows: [row()] }));

    expect(markup).toContain("Limits");
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("5 hour");
    expect(markup).toContain("42%");
    expect(markup).toContain("Max ·");
  });

  // Regression: the limits strip was silently dropped from the app once
  // already. An empty section header with no windows under it reads as a bug,
  // so no provider reporting means no section at all.
  it("renders nothing when no provider reports a window", () => {
    expect(renderToStaticMarkup(createElement(UsageLimitsView, { rows: [] }))).toBe("");
  });

  it("shows a dash rather than a bar when utilization is unknown", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageLimitsView, {
        rows: [
          row({
            window: {
              id: "weekly",
              label: "Weekly",
              utilizationPercent: null,
              resetsAt: null,
              windowMinutes: 10080,
            },
          }),
        ],
      }),
    );

    expect(markup).toContain("—");
    expect(markup).toContain("width:0.0%");
    expect(markup).toContain("Reset time unavailable");
  });

  it("clamps a provider that reports past its own ceiling", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageLimitsView, {
        rows: [row({ window: { ...row().window, utilizationPercent: 137 } })],
      }),
    );

    expect(markup).toContain("137%");
    expect(markup).toContain("width:100.0%");
  });
});
