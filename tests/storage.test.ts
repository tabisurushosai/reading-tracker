/**
 * Unit tests for pure helpers in src/storage.ts.
 *
 * Only date-key formatting, clamping, and trial math are exercised here —
 * the chrome.storage.local-backed loaders/savers are integration concerns
 * and live outside this file.
 */
import { describe, it, expect } from "vitest";
import {
  DAY_MS,
  TRIAL_DAYS,
  clampDailyGoal,
  dailyLogKey,
  formatDateKey,
  hasPremiumAccess,
  trialDaysRemaining,
} from "../src/storage.js";

describe("formatDateKey", () => {
  it("pads single-digit month and day to YYYY-MM-DD", () => {
    expect(formatDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("preserves two-digit month and day", () => {
    expect(formatDateKey(new Date(2026, 10, 23))).toBe("2026-11-23");
  });
});

describe("dailyLogKey", () => {
  it("prefixes the formatted date with daily_log_", () => {
    expect(dailyLogKey(new Date(2026, 4, 18))).toBe("daily_log_2026-05-18");
  });
});

describe("clampDailyGoal", () => {
  it("clamps values below 1 up to 1", () => {
    expect(clampDailyGoal(0)).toBe(1);
    expect(clampDailyGoal(-7)).toBe(1);
  });

  it("clamps values above 100 down to 100", () => {
    expect(clampDailyGoal(101)).toBe(100);
    expect(clampDailyGoal(9999)).toBe(100);
  });

  it("floors decimal values", () => {
    expect(clampDailyGoal(3.9)).toBe(3);
  });

  it("falls back to default for non-finite input", () => {
    expect(clampDailyGoal(NaN)).toBe(1);
    expect(clampDailyGoal("abc")).toBe(1);
    expect(clampDailyGoal(undefined)).toBe(1);
  });
});

describe("trialDaysRemaining", () => {
  const start = 1_700_000_000_000;

  it("returns TRIAL_DAYS at the trial start instant", () => {
    expect(
      trialDaysRemaining({ trial_start_ts: start, premium_unlocked: false }, start)
    ).toBe(TRIAL_DAYS);
  });

  it("returns 0 once the trial window has elapsed", () => {
    expect(
      trialDaysRemaining(
        { trial_start_ts: start, premium_unlocked: false },
        start + TRIAL_DAYS * DAY_MS
      )
    ).toBe(0);
  });

  it("returns Infinity when premium is unlocked", () => {
    expect(
      trialDaysRemaining(
        { trial_start_ts: start, premium_unlocked: true },
        start + 1000 * DAY_MS
      )
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("hasPremiumAccess", () => {
  const start = 1_700_000_000_000;

  it("is true inside the trial window", () => {
    expect(
      hasPremiumAccess(
        { trial_start_ts: start, premium_unlocked: false },
        start + 3 * DAY_MS
      )
    ).toBe(true);
  });

  it("is false after the trial window expires", () => {
    expect(
      hasPremiumAccess(
        { trial_start_ts: start, premium_unlocked: false },
        start + TRIAL_DAYS * DAY_MS
      )
    ).toBe(false);
  });

  it("is true whenever premium_unlocked is set, regardless of elapsed time", () => {
    expect(
      hasPremiumAccess(
        { trial_start_ts: start, premium_unlocked: true },
        start + 365 * DAY_MS
      )
    ).toBe(true);
  });
});
