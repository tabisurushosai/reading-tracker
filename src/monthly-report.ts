/**
 * monthly-report — design skeleton (T028)
 *
 * Purpose
 * ───────
 * Roll up DailyLogs across a calendar-month window into the shape the report
 * page (linked from popup's "月次レポートを見る" button) renders:
 *   - report page (T029 wires up an HTML view) — needs total reads, per-day
 *     calendar grid, difficulty mix, top hosts, longest run inside the month,
 *     and a comparison to last month so the user sees whether the habit is
 *     trending up or down.
 *   - popup.ts (current behaviour falls through to options) — may surface a
 *     "this month so far: N reads" line; monthly-report.computeMonthlyTotals
 *     gives exactly that without the popup re-implementing month boundaries.
 *   - background.ts (later) — month-rollover notification could re-use
 *     loadMonthlyReport(prevMonth) to summarise "you read N articles in 4月".
 *
 * Why a dedicated module instead of inlining into the report HTML view?
 *   The view needs to consume a fully-shaped object — totals, daily grid,
 *   top hosts, difficulty mix, comparison-to-previous — that does not exist
 *   anywhere upstream. read-log gives us the raw Map<dateKey, DailyLog>;
 *   goal-tracker gives us today + rolling 7-day. Neither owns the
 *   *calendar-month* slice, the day-of-week grouping, or the
 *   month-over-month comparison. Putting that calculation in the view means
 *   any future caller (notification, CSV export, popup teaser) has to redo
 *   it. Splitting it out keeps "what counts as a month" — and how we
 *   compare two months fairly when one is still in progress — in one place.
 *
 * Boundary with read-log.ts and goal-tracker.ts
 *   - read-log owns the *log itself* (loadRange, groupByDifficulty,
 *     groupByHost). We compose those helpers rather than walking entries
 *     ourselves — the difficulty/host classification rules live in one
 *     place.
 *   - goal-tracker owns the *today + rolling-week + streak* shape that the
 *     popup needs every open. monthly-report consumes a *month*-shaped
 *     window and produces denser breakdowns (top hosts, by day of week,
 *     month-over-month). We deliberately do NOT re-export goal-tracker's
 *     WeeklyProgress — that view is rolling, this view is calendar.
 *   - storage.ts owns key namespacing (DAILY_LOG_PREFIX, formatDateKey,
 *     dailyLogKey). We import the formatter so date-keys agree exactly.
 *
 * Month window contract
 * ─────────────────────
 *   - A "month" is the local-time calendar month: from day 1 at 00:00 to the
 *     last day at 23:59:59.999. We use the user's local timezone (matching
 *     storage.formatDateKey) so the report aligns with the calendar the
 *     user is actually looking at on their wall.
 *   - `monthOf(date)` returns the calendar month containing `date`. The
 *     report defaults to the current month; the view also fetches the
 *     previous month for the comparison strip.
 *   - The current month is *partial* until the last day rolls over. Totals
 *     reflect actual reads so far; the comparison strip normalises by
 *     "elapsed days in the month" so a half-finished current month is not
 *     unfairly shown as worse than a fully-finished previous month.
 *
 * Daily grid contract
 * ───────────────────
 * The view renders a calendar-style grid (≤31 cells, one per day of the
 * month). We pre-fill every day in the month so the renderer never has to
 * branch on "no entry" vs "entry with zero reads". Each cell carries:
 *   - dateKey (YYYY-MM-DD)
 *   - dayOfMonth (1..31) for the cell label
 *   - dayOfWeek (0=Sun..6=Sat) so the view can place the first cell under
 *     the correct weekday column without re-deriving the calendar layout
 *   - count (reads on that day, respecting difficultyPref)
 *   - met (count >= dailyGoal)
 *   - inFuture (true for days after `today` in the current month — view
 *     can grey them out instead of misleading the user with "zero reads")
 *
 * Top-hosts / by-difficulty / by-day-of-week
 * ──────────────────────────────────────────
 *   - Top hosts: aggregate over every entry in the month via
 *     read-log.groupByHost on the merged entry list. Sorted desc by count,
 *     asc by host for tie-stability so re-renders don't shuffle. We expose
 *     the full list (no truncation) so the view can decide how many to
 *     show inside / outside Premium.
 *   - By-difficulty mix: sum of read-log.groupByDifficulty across the
 *     month. Kept as raw counts (not percentages) so the view can render
 *     either a bar chart or a percentage label without losing precision.
 *   - By-day-of-week: 7-bucket count keyed 0..6 (Sun..Sat). Lets the user
 *     see "I read more on weekends than weekdays" without us choosing a
 *     locale-specific week start.
 *
 * Comparison-to-previous
 * ──────────────────────
 * Naive "this month vs last month" is misleading on the 3rd of the month
 * (a 3-day current month would always look worse). We normalise by:
 *   - "totalCurrent" = reads so far in the current month
 *   - "totalPrevious" = reads in the entire previous month
 *   - "perDayCurrent" = totalCurrent / elapsedDaysInCurrentMonth
 *   - "perDayPrevious" = totalPrevious / daysInPreviousMonth
 *   - "deltaPerDay" = perDayCurrent - perDayPrevious
 * The view chooses which number to render; we provide both raw and
 * normalised so the choice is not baked into the calculation.
 *
 * Premium gating
 * ──────────────
 * The free tier shows the current calendar month — that is enough for the
 * core motivational loop SPEC.md targets. Premium unlocks:
 *   - arbitrary historical months (the view fetches loadMonthlyReport for
 *     any month, free callers only pass the current month)
 *   - the full top-hosts list (free truncates to e.g. top 3)
 *   - the per-day-of-week breakdown
 * As with goal-tracker, monthly-report computes everything unconditionally;
 * the view layer (T031–T032) is the one that gates rendering on
 * hasPremiumAccess. Keeping the gate out of the computation keeps the
 * tests Premium-agnostic and lets us A/B the free-tier slice later without
 * touching this file.
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 *   - Pure synchronous helpers over already-loaded DailyLogs. No fetch, no
 *     URL leakage beyond what read-log already persists locally.
 *   - No chrome.storage.local writes inside this module — it is a read-side
 *     view, so a corrupted month can never poison storage.
 *   - Host names are derived from entry URLs via the standard URL parser
 *     (matches read-log.groupByHost); no third-party PSL lookup, no
 *     network calls.
 *
 * Failure mode
 * ────────────
 *   - loadMonthlyReport() never throws. Storage read failure collapses to
 *     a zero-count report with the requested month boundaries so the view
 *     still renders a sensible empty state rather than an error.
 *   - Inverted / NaN inputs to monthOf / loadMonthlyReport default to the
 *     current month so a misbehaving caller never breaks the report page.
 *   - Comparison-to-previous returns null when the previous month has zero
 *     reads (instead of dividing by zero); the view shows "—" instead of
 *     "+Infinity%".
 *
 * Test surface (T030)
 * ───────────────────
 * Pure helpers — monthOf, monthBounds, computeMonthlyTotals,
 * computeDailyGrid, computeTopHosts, computeDifficultyMix,
 * computeByDayOfWeek, computeMonthOverMonth, computeMonthlyStreak,
 * evaluateMonthlyReport — are exported individually so T030 can table-test
 * them with synthetic DailyLog fixtures and a fixed `today`. The async
 * seam (loadMonthlyReport) takes a MonthlyReportPorts so the same tests
 * drive it with in-memory chrome.storage.local fakes layered over
 * read-log.loadRange (mirrors the goal-tracker.test.ts installStorageFake
 * pattern).
 */

import {
  formatDateKey,
  type DailyLog,
  type Settings,
} from "./storage.js";
import {
  groupByDifficulty,
  loadRange as readLogLoadRange,
  type DifficultyBreakdown,
  type HostBreakdown,
} from "./read-log.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Identifies a calendar month in the user's local timezone. Kept as
 * `{year, month}` (month is 0-indexed to match `Date#getMonth()`) rather
 * than a Date so two reports for the same month never disagree because
 * one was constructed from a midnight-rollover edge case.
 */
export interface MonthRef {
  /** Four-digit calendar year. */
  year: number;
  /** Zero-indexed month (0 = Jan, 11 = Dec) — matches Date#getMonth(). */
  month: number;
}

/**
 * Inclusive half-open boundaries of a month, in epoch ms. `start` is the
 * first instant of day 1; `endExclusive` is the first instant of day 1 of
 * the *next* month. Used to slice loadRange windows without timezone math
 * leaking into the view.
 */
export interface MonthBounds {
  ref: MonthRef;
  /** YYYY-MM-DD of day 1 (matches storage.formatDateKey). */
  startDateKey: string;
  /** YYYY-MM-DD of the last day of the month. */
  endDateKey: string;
  /** Number of calendar days in the month (28..31). */
  daysInMonth: number;
}

/**
 * One cell in the daily calendar grid. Always pre-filled for every day in
 * the month so the renderer never branches on "no data". `inFuture` marks
 * days after today in the current month so the view can render them muted.
 */
export interface DailyGridCell {
  /** YYYY-MM-DD key. */
  dateKey: string;
  /** 1..31 — the cell's number label. */
  dayOfMonth: number;
  /** 0=Sunday..6=Saturday — for the weekday column placement. */
  dayOfWeek: number;
  /** Reads on that day after applying settings.difficultyPref. */
  count: number;
  /** True iff count >= settings.dailyGoal that day. */
  met: boolean;
  /** True for days strictly after `today` (only relevant for current month). */
  inFuture: boolean;
}

/**
 * 7-bucket "reads by weekday" rollup. Index 0 = Sunday so callers can use
 * Date#getDay() directly. Values are raw counts; the view computes
 * percentages if needed.
 */
export interface DayOfWeekBreakdown {
  /** counts[0]=Sun..counts[6]=Sat. */
  counts: number[];
}

/**
 * Month-over-month comparison. `null` fields signal "previous month has no
 * data" — the view renders "—" rather than dividing by zero.
 */
export interface MonthOverMonth {
  /** Reads so far this month (respects difficultyPref). */
  totalCurrent: number;
  /** Reads in the entire previous month (null if no data). */
  totalPrevious: number | null;
  /** totalCurrent / elapsedDaysInCurrentMonth. */
  perDayCurrent: number;
  /** totalPrevious / daysInPreviousMonth (null if no data). */
  perDayPrevious: number | null;
  /** perDayCurrent - perDayPrevious (null if no previous data). */
  deltaPerDay: number | null;
  /** Elapsed-day count used as the denominator for perDayCurrent. */
  elapsedDaysCurrent: number;
}

/**
 * Streak summary scoped to a single month. Distinct from goal-tracker's
 * StreakState (which is today-anchored across all history) — this one
 * answers "what was your longest run *inside* this month?".
 */
export interface MonthlyStreak {
  /** Longest consecutive-days run found within the month. */
  longestInMonth: number;
  /** Number of days within the month with count >= 1. */
  activeDays: number;
}

/**
 * Top-level report consumed by the report page. Composes totals + grid +
 * breakdowns + comparison + streak so the renderer fetches one object.
 */
export interface MonthlyReport {
  ref: MonthRef;
  bounds: MonthBounds;
  /** Total reads in the month (respects difficultyPref). */
  totalReads: number;
  /** Total reads ignoring difficultyPref — used for the breakdown bar. */
  totalReadsUnfiltered: number;
  /** Per-difficulty rollup across the month (unfiltered). */
  byDifficulty: DifficultyBreakdown;
  /** Per-host rollup across the month, sorted desc by count. */
  topHosts: HostBreakdown[];
  /** Per-day-of-week rollup. */
  byDayOfWeek: DayOfWeekBreakdown;
  /** Pre-filled calendar grid, length === bounds.daysInMonth. */
  dailyGrid: DailyGridCell[];
  /** Month-over-month comparison vs the previous calendar month. */
  comparison: MonthOverMonth;
  /** Streak summary scoped to this month. */
  streak: MonthlyStreak;
  /** Epoch ms when this snapshot was evaluated. */
  evaluatedAt: number;
}

/**
 * Ports for the async seams. Mirrors GoalTrackerPorts so the same chrome.*
 * fakes already used by read-log.test.ts / goal-tracker.test.ts can be
 * reused. All fields are optional because production uses chrome.storage +
 * read-log.loadRange directly.
 */
export interface MonthlyReportPorts {
  /** Inject a clock so tests can pin `today`; defaults to Date.now. */
  now?: () => number;
  /**
   * Override the range loader. Defaults to read-log.loadRange. Same shape
   * monthly-report's siblings (goal-tracker.loadGoalState) accept so a
   * caller building both views can pass a single port object.
   */
  loadRange?: (from: Date, to: Date) => Promise<Map<string, DailyLog>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum days we will pre-fill in a daily grid. 31 covers every calendar
 * month; the constant exists so the renderer can size its grid array
 * statically and so a corrupted MonthBounds.daysInMonth can never explode
 * the loop.
 */
export const MAX_DAYS_IN_MONTH = 31;

/**
 * Number of weekday buckets in DayOfWeekBreakdown. Seven by definition;
 * exposed as a constant so the view does not magic-number `7` when it
 * iterates the bucket labels.
 */
export const DAYS_IN_WEEK = 7;

/**
 * Soft cap on entries returned by computeTopHosts. We do NOT truncate at
 * this layer — the view decides how many rows to show based on Premium
 * status. The constant is exported so the free-tier view (T031–T032) has
 * a single place to read the recommended free-tier ceiling from.
 */
export const FREE_TIER_TOP_HOSTS = 3;

// ---------------------------------------------------------------------------
// Pure helpers — T029 implements, T030 tests
// ---------------------------------------------------------------------------

function safeDifficultyPref(settings: Settings | undefined | null): Settings["difficultyPref"] {
  const pref = settings?.difficultyPref;
  return pref === "easy" || pref === "medium" || pref === "hard" || pref === "any"
    ? pref
    : "any";
}

function safeDailyGoal(settings: Settings | undefined | null): number {
  const g = settings?.dailyGoal;
  return typeof g === "number" && g > 0 ? g : 1;
}

function countWithPref(log: DailyLog | undefined, pref: Settings["difficultyPref"]): number {
  if (!log) return 0;
  if (pref === "any") return log.count ?? 0;
  return groupByDifficulty(log)[pref];
}

/**
 * Return the calendar month containing `date` (local time). Falls back to
 * the current month when `date` is missing or invalid so the report page
 * always renders.
 */
export function monthOf(date: Date): MonthRef {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }
  return { year: date.getFullYear(), month: date.getMonth() };
}

/**
 * Compute the inclusive start/end date keys and day count for a MonthRef.
 * Validates the ref (clamps month into 0..11 and treats non-finite year as
 * the current year) so a misbehaving caller never produces a "month 13"
 * window that loadRange would treat as empty.
 */
export function monthBounds(ref: MonthRef): MonthBounds {
  const fallbackNow = new Date();
  const year =
    ref && typeof ref.year === "number" && Number.isFinite(ref.year)
      ? Math.floor(ref.year)
      : fallbackNow.getFullYear();
  const rawMonth =
    ref && typeof ref.month === "number" && Number.isFinite(ref.month)
      ? Math.floor(ref.month)
      : fallbackNow.getMonth();
  const month = Math.min(11, Math.max(0, rawMonth));
  const start = new Date(year, month, 1);
  // Day 0 of the next month = last day of this month.
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  return {
    ref: { year, month },
    startDateKey: formatDateKey(start),
    endDateKey: formatDateKey(lastDay),
    daysInMonth,
  };
}

/**
 * Sum reads across the month, returning both the filtered total
 * (respecting settings.difficultyPref) and the unfiltered total used by
 * the breakdown bar. Composes read-log.groupByDifficulty so the
 * difficulty classification rule stays canonical.
 */
export function computeMonthlyTotals(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
  settings: Settings,
): { totalReads: number; totalReadsUnfiltered: number } {
  const pref = safeDifficultyPref(settings);
  let totalReads = 0;
  let totalReadsUnfiltered = 0;
  if (!logsByDate || !bounds) return { totalReads, totalReadsUnfiltered };
  for (const [key, log] of logsByDate) {
    if (key < bounds.startDateKey || key > bounds.endDateKey) continue;
    if (!log) continue;
    totalReadsUnfiltered += log.count ?? 0;
    totalReads += countWithPref(log, pref);
  }
  return { totalReads, totalReadsUnfiltered };
}

/**
 * Pre-fill one DailyGridCell per day in the month. Days with no log have
 * count=0 / met=false; days strictly after `today` have inFuture=true so
 * the renderer can mute them.
 */
export function computeDailyGrid(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
  settings: Settings,
  today: Date,
): DailyGridCell[] {
  const pref = safeDifficultyPref(settings);
  const goal = safeDailyGoal(settings);
  const safeToday =
    today instanceof Date && !Number.isNaN(today.getTime())
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
      : new Date();
  const todayKey = formatDateKey(safeToday);
  const cells: DailyGridCell[] = [];
  const limit = Math.min(MAX_DAYS_IN_MONTH, Math.max(0, bounds?.daysInMonth ?? 0));
  for (let day = 1; day <= limit; day += 1) {
    const cursor = new Date(bounds.ref.year, bounds.ref.month, day);
    const dateKey = formatDateKey(cursor);
    const log = logsByDate?.get?.(dateKey);
    const count = countWithPref(log, pref);
    const met = count >= goal;
    cells.push({
      dateKey,
      dayOfMonth: day,
      dayOfWeek: cursor.getDay(),
      count,
      met,
      inFuture: dateKey > todayKey,
    });
  }
  return cells;
}

/**
 * Aggregate host counts across every entry in the month. Returns the full
 * list — the view truncates per Premium. Sorted desc by count, asc by
 * host for tie-stability (matches read-log.groupByHost ordering).
 */
export function computeTopHosts(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
): HostBreakdown[] {
  const counts = new Map<string, number>();
  if (!logsByDate || !bounds) return [];
  for (const [key, log] of logsByDate) {
    if (key < bounds.startDateKey || key > bounds.endDateKey) continue;
    if (!log?.entries) continue;
    for (const entry of log.entries) {
      let host = "";
      try {
        host = new URL(entry.url).hostname.toLowerCase();
      } catch {
        host = "";
      }
      if (!host) continue;
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }
  const rows: HostBreakdown[] = [];
  for (const [host, count] of counts) rows.push({ host, count });
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.host < b.host ? -1 : a.host > b.host ? 1 : 0;
  });
  return rows;
}

/**
 * Aggregate difficulty buckets across every entry in the month. Always
 * unfiltered by difficultyPref so the breakdown bar can show what the
 * user actually read (independent of their goal-difficulty preference).
 */
export function computeDifficultyMix(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
): DifficultyBreakdown {
  const out: DifficultyBreakdown = { easy: 0, medium: 0, hard: 0, unknown: 0 };
  if (!logsByDate || !bounds) return out;
  for (const [key, log] of logsByDate) {
    if (key < bounds.startDateKey || key > bounds.endDateKey) continue;
    if (!log) continue;
    const part = groupByDifficulty(log);
    out.easy += part.easy;
    out.medium += part.medium;
    out.hard += part.hard;
    out.unknown += part.unknown;
  }
  return out;
}

/**
 * Bucket reads by Date#getDay() (0=Sun..6=Sat). Index 0..6 is locale-free;
 * the view labels the buckets per chrome.i18n.
 */
export function computeByDayOfWeek(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
  settings: Settings,
): DayOfWeekBreakdown {
  const pref = safeDifficultyPref(settings);
  const counts: number[] = new Array(DAYS_IN_WEEK).fill(0);
  if (!logsByDate || !bounds) return { counts };
  for (const [key, log] of logsByDate) {
    if (key < bounds.startDateKey || key > bounds.endDateKey) continue;
    if (!log) continue;
    const parts = key.split("-");
    if (parts.length !== 3) continue;
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) continue;
    const dow = new Date(y, m - 1, d).getDay();
    if (dow < 0 || dow >= DAYS_IN_WEEK) continue;
    counts[dow] += countWithPref(log, pref);
  }
  return { counts };
}

/**
 * Compute the month-over-month comparison. `today` is needed to derive
 * `elapsedDaysCurrent` (only days up to and including today count for the
 * current month, even though the month bounds extend further). Returns
 * null-valued comparison fields when `previousLogsByDate` is empty so the
 * view renders "—" instead of dividing by zero.
 */
export function computeMonthOverMonth(
  currentLogsByDate: ReadonlyMap<string, DailyLog>,
  previousLogsByDate: ReadonlyMap<string, DailyLog>,
  currentBounds: MonthBounds,
  previousBounds: MonthBounds,
  settings: Settings,
  today: Date,
): MonthOverMonth {
  const totalCurrent = computeMonthlyTotals(currentLogsByDate, currentBounds, settings).totalReads;
  const previousTotals = computeMonthlyTotals(
    previousLogsByDate,
    previousBounds,
    settings,
  ).totalReads;
  const safeToday =
    today instanceof Date && !Number.isNaN(today.getTime())
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
      : new Date();
  const todayKey = formatDateKey(safeToday);
  let elapsedDaysCurrent: number;
  if (todayKey < currentBounds.startDateKey) {
    // Today precedes the requested month → caller is viewing a future month.
    elapsedDaysCurrent = 0;
  } else if (todayKey > currentBounds.endDateKey) {
    // Today is after the month → full month is "elapsed".
    elapsedDaysCurrent = currentBounds.daysInMonth;
  } else {
    elapsedDaysCurrent = safeToday.getDate();
  }
  const perDayCurrent =
    elapsedDaysCurrent > 0 ? totalCurrent / elapsedDaysCurrent : 0;
  const hasPrevious =
    previousLogsByDate && previousLogsByDate.size > 0 && previousTotals > 0;
  const totalPrevious = hasPrevious ? previousTotals : null;
  const perDayPrevious =
    hasPrevious && previousBounds.daysInMonth > 0
      ? previousTotals / previousBounds.daysInMonth
      : null;
  const deltaPerDay =
    perDayPrevious === null ? null : perDayCurrent - perDayPrevious;
  return {
    totalCurrent,
    totalPrevious,
    perDayCurrent,
    perDayPrevious,
    deltaPerDay,
    elapsedDaysCurrent,
  };
}

/**
 * Longest consecutive-days run that lies entirely within `bounds`, and the
 * number of distinct days inside the month with count >= 1. Streak is
 * intentionally not filtered by difficultyPref (matches goal-tracker.computeStreak).
 */
export function computeMonthlyStreak(
  logsByDate: ReadonlyMap<string, DailyLog>,
  bounds: MonthBounds,
): MonthlyStreak {
  if (!logsByDate || !bounds) return { longestInMonth: 0, activeDays: 0 };
  let longestInMonth = 0;
  let activeDays = 0;
  let run = 0;
  const limit = Math.min(MAX_DAYS_IN_MONTH, Math.max(0, bounds.daysInMonth));
  for (let day = 1; day <= limit; day += 1) {
    const cursor = new Date(bounds.ref.year, bounds.ref.month, day);
    const key = formatDateKey(cursor);
    const log = logsByDate.get(key);
    if (log && (log.count ?? 0) >= 1) {
      run += 1;
      activeDays += 1;
      if (run > longestInMonth) longestInMonth = run;
    } else {
      run = 0;
    }
  }
  return { longestInMonth, activeDays };
}

/**
 * Compose every helper into a MonthlyReport. Pure; T029 implements as a
 * thin wrapper so callers fetch one object and get the full view.
 */
export function evaluateMonthlyReport(
  ref: MonthRef,
  currentLogsByDate: ReadonlyMap<string, DailyLog>,
  previousLogsByDate: ReadonlyMap<string, DailyLog>,
  settings: Settings,
  today: Date,
  now: number,
): MonthlyReport {
  const bounds = monthBounds(ref);
  const prevRef: MonthRef =
    bounds.ref.month === 0
      ? { year: bounds.ref.year - 1, month: 11 }
      : { year: bounds.ref.year, month: bounds.ref.month - 1 };
  const previousBounds = monthBounds(prevRef);
  const totals = computeMonthlyTotals(currentLogsByDate, bounds, settings);
  const dailyGrid = computeDailyGrid(currentLogsByDate, bounds, settings, today);
  const topHosts = computeTopHosts(currentLogsByDate, bounds);
  const byDifficulty = computeDifficultyMix(currentLogsByDate, bounds);
  const byDayOfWeek = computeByDayOfWeek(currentLogsByDate, bounds, settings);
  const comparison = computeMonthOverMonth(
    currentLogsByDate,
    previousLogsByDate,
    bounds,
    previousBounds,
    settings,
    today,
  );
  const streak = computeMonthlyStreak(currentLogsByDate, bounds);
  return {
    ref: bounds.ref,
    bounds,
    totalReads: totals.totalReads,
    totalReadsUnfiltered: totals.totalReadsUnfiltered,
    byDifficulty,
    topHosts,
    byDayOfWeek,
    dailyGrid,
    comparison,
    streak,
    evaluatedAt: typeof now === "number" && Number.isFinite(now) ? now : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Async seam — T029 wires to chrome.storage / read-log; T030 fakes via ports
// ---------------------------------------------------------------------------

function emptyMonthlyReport(ref: MonthRef, today: Date, now: number): MonthlyReport {
  const settings: Settings = {
    schemaVersion: 1,
    dailyGoal: 1,
    difficultyPref: "any",
    theme: "auto",
  };
  return evaluateMonthlyReport(ref, new Map(), new Map(), settings, today, now);
}

/**
 * Load the DailyLogs for `ref` and the previous month, then evaluate. When
 * `ref` is omitted the current calendar month is used. Never throws;
 * storage failures collapse to a zero-reads report so the view still
 * renders a sensible empty state instead of an error page.
 *
 * Loads two months worth of logs (current + previous) so the comparison
 * strip can be computed without a second round-trip. Two months × ~31 days
 * × <1 KB per log is well inside the chrome.storage.local budget; we do
 * not paginate here.
 */
export async function loadMonthlyReport(
  ref?: MonthRef,
  ports?: MonthlyReportPorts,
): Promise<MonthlyReport> {
  const nowFn = ports?.now ?? Date.now;
  let nowMs: number;
  try {
    const v = nowFn();
    nowMs = typeof v === "number" && Number.isFinite(v) ? v : Date.now();
  } catch {
    nowMs = Date.now();
  }
  const today = new Date(nowMs);
  const targetRef: MonthRef =
    ref &&
    typeof ref.year === "number" &&
    Number.isFinite(ref.year) &&
    typeof ref.month === "number" &&
    Number.isFinite(ref.month)
      ? { year: Math.floor(ref.year), month: Math.min(11, Math.max(0, Math.floor(ref.month))) }
      : monthOf(today);
  const bounds = monthBounds(targetRef);
  const prevRef: MonthRef =
    bounds.ref.month === 0
      ? { year: bounds.ref.year - 1, month: 11 }
      : { year: bounds.ref.year, month: bounds.ref.month - 1 };
  const prevBounds = monthBounds(prevRef);

  let settings: Settings;
  try {
    const { settings: raw } = await chrome.storage.local.get("settings");
    if (raw && typeof raw === "object") {
      const r = raw as Partial<Settings>;
      settings = {
        schemaVersion: 1,
        dailyGoal: typeof r.dailyGoal === "number" && r.dailyGoal > 0 ? r.dailyGoal : 1,
        difficultyPref:
          r.difficultyPref === "easy" ||
          r.difficultyPref === "medium" ||
          r.difficultyPref === "hard" ||
          r.difficultyPref === "any"
            ? r.difficultyPref
            : "any",
        theme:
          r.theme === "light" || r.theme === "dark" || r.theme === "auto"
            ? r.theme
            : "auto",
      };
    } else {
      settings = { schemaVersion: 1, dailyGoal: 1, difficultyPref: "any", theme: "auto" };
    }
  } catch {
    settings = { schemaVersion: 1, dailyGoal: 1, difficultyPref: "any", theme: "auto" };
  }

  const loadRangeFn = ports?.loadRange ?? readLogLoadRange;
  const currentStart = new Date(bounds.ref.year, bounds.ref.month, 1);
  const currentEnd = new Date(bounds.ref.year, bounds.ref.month, bounds.daysInMonth);
  const prevStart = new Date(prevBounds.ref.year, prevBounds.ref.month, 1);
  const prevEnd = new Date(prevBounds.ref.year, prevBounds.ref.month, prevBounds.daysInMonth);

  let currentLogs: Map<string, DailyLog>;
  let previousLogs: Map<string, DailyLog>;
  try {
    currentLogs = await loadRangeFn(currentStart, currentEnd);
  } catch {
    currentLogs = new Map();
  }
  if (!currentLogs) currentLogs = new Map();
  try {
    previousLogs = await loadRangeFn(prevStart, prevEnd);
  } catch {
    previousLogs = new Map();
  }
  if (!previousLogs) previousLogs = new Map();

  try {
    return evaluateMonthlyReport(
      bounds.ref,
      currentLogs,
      previousLogs,
      settings,
      today,
      nowMs,
    );
  } catch {
    return emptyMonthlyReport(bounds.ref, today, nowMs);
  }
}
