/**
 * goal-tracker — design skeleton (T025)
 *
 * Purpose
 * ───────
 * Turn the raw DailyLogs that read-log persists into a goal-progress view the
 * UI layers consume:
 *   - popup.ts                   — needs "today's count / goal / %, did the
 *                                  user just meet today's goal?" so the
 *                                  progress bar and celebratory toast can
 *                                  render without re-implementing the rule.
 *   - monthly-report (T028–T030) — needs "days-met-this-week / streak / longest
 *                                  streak" as part of the rollup so it does
 *                                  not duplicate the streak walk.
 *   - background.ts (later)      — may fire a one-shot "goal met!" notification
 *                                  per day; goal-tracker tells it whether
 *                                  today already crossed the threshold and
 *                                  whether we've already notified for today.
 *
 * Why a dedicated module instead of inlining into popup.ts?
 *   popup.ts at HEAD only renders `today.count` and `settings.dailyGoal` side
 *   by side. As soon as we add a weekly trend or a streak, the same arithmetic
 *   has to exist on the monthly-report page and inside any future background
 *   notification path. Splitting the concern out gives those three callers
 *   one shared rule for "what counts as meeting today's goal" and how the
 *   weekly window is sliced — which is exactly the lever a user-facing goal
 *   feature must keep consistent or the numbers stop matching across screens.
 *
 * Boundary with read-log.ts
 *   read-log.ts owns the *log itself*: dedupe, append, range queries, single-
 *   day aggregates (summarizeLog, streakDays, groupByDifficulty). goal-tracker
 *   sits on top and produces the *goal-shaped* views: percent-of-goal, week-
 *   window summaries, longest-streak walk, "fire notification once" gate.
 *   Whenever read-log already exposes a helper for a piece (e.g. streakDays,
 *   summarizeLog), goal-tracker composes it instead of re-deriving the rule.
 *
 * Goal evaluation contract
 * ────────────────────────
 *   - "Today met" uses read-log.summarizeLog(log, settings.dailyGoal,
 *     settings.difficultyPref). The difficultyPref filter therefore propagates
 *     end-to-end: if the user's pref is "hard", easy entries don't satisfy
 *     today's goal, but they still show up in the byDifficulty breakdown so
 *     the user can see what they actually read.
 *   - "Percent" is clamped to [0, 1]. We do *not* let it exceed 1 because the
 *     popup renders a progress bar that would otherwise visually overflow,
 *     and the celebratory state ("goal met!") is the same regardless of how
 *     far past the goal the user went. The actual count is shown numerically
 *     for users who care about the over-shoot.
 *   - "Week" is a rolling 7-day window ending today (inclusive). Anchoring on
 *     a calendar week boundary (Mon/Sun) would force a locale decision and
 *     give a sparse view on the first day of the week. Rolling avoids both.
 *   - "Streak" reuses read-log.streakDays for the current streak so the rule
 *     stays in one place. Longest streak is computed here because it requires
 *     a full walk of logsByDate rather than just a today-anchored backtrack.
 *
 * Notification gate (one toast per day, max)
 * ──────────────────────────────────────────
 * Crossing the goal should give the user one acknowledgement per day, not one
 * per popup open or one per appended entry. We persist a single key per day
 * (`goal_met_notified_YYYY-MM-DD`) so any caller — popup celebratory toast,
 * background notification — can ask "should I fire?" and get a stable yes/no.
 * Cleared automatically when the day rolls over because we only ever read the
 * key matching today's date; stale keys are GC'd by resetAll/exportAll flows.
 *
 * Premium gating
 * ──────────────
 * The free tier shows today's progress and the current streak — those are the
 * core motivational signals SPEC.md's target audiences (不登校児・発達特性児,
 * Homeschool families) actually need to keep going. Detailed weekly breakdowns,
 * per-difficulty trend, and longest-streak history fall under SPEC.md's
 * "詳細統計 / 無制限 / カスタマイズ拡張" Premium scope. goal-tracker computes
 * everything unconditionally and exposes a `view` field on GoalState that
 * callers can filter; we do NOT branch inside the computation, so test
 * coverage and Premium behaviour stay decoupled (T031–T032 owns the gate).
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 *   - Pure synchronous helpers over already-loaded DailyLogs. No fetch, no
 *     URL leakage beyond what read-log already persists locally.
 *   - The notification gate writes a single boolean-per-day key into
 *     chrome.storage.local. No payload, no host, no URL — purely a "we
 *     already celebrated today" flag.
 *   - No chrome.notifications usage inside this module: the gate decides
 *     *whether* to notify, the caller (background.ts / popup.ts) decides
 *     *how*. Keeps the SPEC-mandated minimum-permission posture intact.
 *
 * Failure mode
 * ────────────
 *   - loadGoalState() never throws. Missing today log → zero-count state.
 *     storage.get failure → state computed from an empty window.
 *   - shouldFireGoalMetNotification() returns false on any storage error so
 *     a flaky read never produces a duplicate notification.
 *   - markGoalMetNotificationFired() swallows write errors; the worst case
 *     is the user gets a second notification, which is far better than a
 *     thrown exception breaking the popup.
 *
 * Test surface (T027)
 * ───────────────────
 * Pure helpers — computeGoalProgress, computeWeeklyProgress, computeStreak,
 * evaluateGoalState — are exported individually so T027 can table-test them
 * with synthetic DailyLog / Settings fixtures and a fixed `today`. The async
 * seams (loadGoalState, shouldFireGoalMetNotification,
 * markGoalMetNotificationFired) take a GoalTrackerPorts so the same tests
 * drive them with in-memory chrome.storage.local fakes layered over storage.ts
 * (mirrors the read-log.test.ts installStorageFake() pattern).
 */

import {
  formatDateKey,
  loadDailyLog as storageLoadDailyLog,
  type DailyLog,
  type Settings,
} from "./storage.js";
import {
  groupByDifficulty,
  loadRange as readLogLoadRange,
  streakDays,
  summarizeLog,
  type DifficultyBreakdown,
} from "./read-log.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Single-day progress shown in the popup's primary line ("3 / 5 today").
 * `percent` is clamped to [0, 1]; `count` is the raw (possibly-over-goal) value.
 */
export interface GoalProgress {
  /** Entries that count toward the goal under the user's difficultyPref. */
  count: number;
  /** The user's daily goal (>= 1; settings.clampDailyGoal already enforces this). */
  goal: number;
  /** count / goal, clamped to [0, 1] for progress-bar rendering. */
  percent: number;
  /** True once count >= goal. Mirrors read-log.summarizeLog.goalMet. */
  met: boolean;
  /** Full unfiltered breakdown so the popup can show all reads regardless of pref. */
  byDifficulty: DifficultyBreakdown;
}

/**
 * One slot inside WeeklyProgress.perDay. Always one entry per day in the
 * rolling window even when the day has no log, so renderers can draw a stable
 * 7-bar chart without sparse-data branches.
 */
export interface DailyProgressSlot {
  /** YYYY-MM-DD key matching storage.formatDateKey. */
  date: string;
  /** Reads on that day that satisfied the user's difficultyPref. */
  count: number;
  /** Convenience: count >= settings.dailyGoal for that day. */
  met: boolean;
}

/**
 * Rolling 7-day summary ending on `today` (inclusive). Days with no log
 * appear with count=0 and met=false so the array length is always WEEK_WINDOW_DAYS.
 */
export interface WeeklyProgress {
  /** YYYY-MM-DD of the oldest slot in `perDay`. */
  startDate: string;
  /** YYYY-MM-DD of the newest slot in `perDay` (= today). */
  endDate: string;
  /** Number of slots in `perDay` where met=true. */
  daysMet: number;
  /** Always equal to WEEK_WINDOW_DAYS; included so callers don't re-derive. */
  totalDays: number;
  /** Oldest → newest ordering so the chart axis reads left-to-right. */
  perDay: DailyProgressSlot[];
}

/**
 * Streak state derived from a logsByDate map. `current` reuses
 * read-log.streakDays so the today-anchored rule lives in one place; `longest`
 * walks the same map and remembers the maximum contiguous run found anywhere.
 */
export interface StreakState {
  /** Days, inclusive of today, that have count >= 1 with no gaps. */
  current: number;
  /** Longest run of consecutive days with count >= 1 anywhere in the map. */
  longest: number;
  /** True when today itself had >= 1 read. Exposed so popups can skip "streak in danger" copy. */
  todayMet: boolean;
}

/**
 * Top-level goal view consumed by popup.ts and monthly-report.
 * Composes today / week / streak so renderers fetch one object, not three.
 */
export interface GoalState {
  today: GoalProgress;
  week: WeeklyProgress;
  streak: StreakState;
  /**
   * Date this snapshot was taken (epoch ms). Lets the popup decide whether
   * to re-fetch (e.g. on a long-lived popup where the day might roll over).
   */
  evaluatedAt: number;
}

/**
 * Ports for the async seams. Mirrors ReadLogPorts so the same chrome.* fakes
 * already used by read-log.test.ts can be reused. All fields are optional
 * because the production path uses chrome.storage.local + Date.now directly.
 */
export interface GoalTrackerPorts {
  /** Inject a clock so tests can pin `today`; defaults to Date.now. */
  now?: () => number;
  /**
   * Override the today-log loader. Defaults to read-log/storage.loadDailyLog
   * so callers don't have to wire it up. Tests pass an in-memory map.
   */
  loadDailyLog?: (date: Date) => Promise<DailyLog>;
  /**
   * Override the range loader. Defaults to read-log.loadRange. We accept any
   * function returning a Map keyed by storage.formatDateKey strings — same
   * shape monthly-report (T028) will consume.
   */
  loadRange?: (from: Date, to: Date) => Promise<Map<string, DailyLog>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Length of the rolling weekly window. Seven matches the user's mental model
 * of a "week" without forcing a Mon/Sun anchor decision. Kept as a constant
 * so monthly-report can reference the exact same slice when it renders the
 * "this week" card alongside the monthly grid.
 */
export const WEEK_WINDOW_DAYS = 7;

/**
 * Upper bound on the longest-streak walk. Matches read-log's 366-day cap so
 * the two streak computations terminate on the same horizon and a corrupted
 * logsByDate map can never spin a UI thread.
 */
export const STREAK_LOOKBACK_DAYS = 366;

/**
 * Storage key prefix for the "we already celebrated this day" flag. The full
 * key is `${GOAL_MET_NOTIFICATION_KEY_PREFIX}${formatDateKey(today)}`, so old
 * days' flags occupy negligible space and are cleared by resetAll. We keep
 * the per-day shape (rather than a single rolling key) so two popups opened
 * in two windows on the same day don't race to double-notify.
 */
export const GOAL_MET_NOTIFICATION_KEY_PREFIX = "goal_met_notified_";

// ---------------------------------------------------------------------------
// Pure helpers — T026 implements, T027 tests
// ---------------------------------------------------------------------------

/**
 * Compute today's GoalProgress from a DailyLog and the user's Settings.
 * Delegates to read-log.summarizeLog for the count/goalMet/byDifficulty rule
 * so the difficultyPref filter stays defined in exactly one place.
 *
 * `percent` is clamped to [0, 1] before return. dailyGoal <= 0 is treated as
 * 1 (same fallback as summarizeLog) so a bad settings record never yields a
 * NaN/Infinity percent that the popup CSS would render as a broken bar.
 */
export function computeGoalProgress(
  log: DailyLog,
  settings: Settings,
): GoalProgress {
  const goal = settings && settings.dailyGoal > 0 ? settings.dailyGoal : 1;
  const pref = settings?.difficultyPref ?? "any";
  const summary = summarizeLog(log, goal, pref);
  const raw = goal > 0 ? summary.count / goal : 0;
  const percent = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  return {
    count: summary.count,
    goal,
    percent,
    met: summary.goalMet,
    byDifficulty: summary.byDifficulty,
  };
}

/**
 * Build the rolling 7-day window ending on `today`. Days absent from
 * `logsByDate` appear as count=0 / met=false slots so renderers always get a
 * length-WEEK_WINDOW_DAYS array. Counts respect settings.difficultyPref so
 * the weekly view is internally consistent with today's progress bar.
 */
export function computeWeeklyProgress(
  logsByDate: ReadonlyMap<string, DailyLog>,
  settings: Settings,
  today: Date,
): WeeklyProgress {
  const goal = settings && settings.dailyGoal > 0 ? settings.dailyGoal : 1;
  const pref = settings?.difficultyPref ?? "any";
  const safeToday =
    today instanceof Date && !Number.isNaN(today.getTime())
      ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
      : new Date();
  const perDay: DailyProgressSlot[] = [];
  let daysMet = 0;
  for (let i = WEEK_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const cursor = new Date(safeToday);
    cursor.setDate(safeToday.getDate() - i);
    const key = formatDateKey(cursor);
    const log = logsByDate?.get?.(key);
    let count = 0;
    if (log) {
      if (pref === "any") {
        count = log.count ?? 0;
      } else {
        count = groupByDifficulty(log)[pref];
      }
    }
    const met = count >= goal;
    if (met) daysMet += 1;
    perDay.push({ date: key, count, met });
  }
  return {
    startDate: perDay[0]?.date ?? formatDateKey(safeToday),
    endDate: perDay[perDay.length - 1]?.date ?? formatDateKey(safeToday),
    daysMet,
    totalDays: WEEK_WINDOW_DAYS,
    perDay,
  };
}

/**
 * Compute current + longest streak from a logsByDate map. `current` defers to
 * read-log.streakDays so the today-anchored rule (STREAK_TOLERANCE_DAYS=0,
 * count>=1) stays canonical; `longest` walks the map sorted by date and
 * tracks the maximum gap-free run within the last STREAK_LOOKBACK_DAYS.
 *
 * "Streak" is intentionally not filtered by difficultyPref. The streak's job
 * is to reward consistency of *any* reading; gating it by difficulty would
 * disincentivize easy reads on tired days and defeats the encouragement loop.
 */
export function computeStreak(
  logsByDate: ReadonlyMap<string, DailyLog>,
  today: Date,
): StreakState {
  const safeToday =
    today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date();
  const current = streakDays(logsByDate ?? new Map(), safeToday);
  let longest = 0;
  if (logsByDate && typeof logsByDate.entries === "function") {
    const days: string[] = [];
    for (const [key, log] of logsByDate) {
      if (log && (log.count ?? 0) >= 1) days.push(key);
    }
    days.sort();
    let run = 0;
    let prev: Date | null = null;
    for (const key of days) {
      const parts = key.split("-");
      if (parts.length !== 3) {
        run = 0;
        prev = null;
        continue;
      }
      const y = Number(parts[0]);
      const m = Number(parts[1]);
      const d = Number(parts[2]);
      if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
        run = 0;
        prev = null;
        continue;
      }
      const cur = new Date(y, m - 1, d);
      if (prev) {
        const diff = Math.round(
          (cur.getTime() - prev.getTime()) / (24 * 60 * 60 * 1000),
        );
        if (diff === 1) {
          run += 1;
        } else {
          run = 1;
        }
      } else {
        run = 1;
      }
      if (run > longest) longest = run;
      prev = cur;
    }
  }
  if (current > longest) longest = current;
  const todayKey = formatDateKey(safeToday);
  const todayLog = logsByDate?.get?.(todayKey);
  const todayMet = !!todayLog && (todayLog.count ?? 0) >= 1;
  return { current, longest, todayMet };
}

/**
 * Compose computeGoalProgress + computeWeeklyProgress + computeStreak into a
 * single GoalState. Pure; T026 implements as a thin wrapper so the popup can
 * call one function and get every view it renders.
 */
export function evaluateGoalState(
  todayLog: DailyLog,
  logsByDate: ReadonlyMap<string, DailyLog>,
  settings: Settings,
  today: Date,
  now: number,
): GoalState {
  return {
    today: computeGoalProgress(todayLog, settings),
    week: computeWeeklyProgress(logsByDate, settings, today),
    streak: computeStreak(logsByDate, today),
    evaluatedAt: typeof now === "number" && Number.isFinite(now) ? now : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Async seams — T026 wires to chrome.storage / read-log; T027 fakes via ports
// ---------------------------------------------------------------------------

/**
 * Load today's DailyLog + the rolling 7-day window via the supplied ports
 * (or the production defaults), call evaluateGoalState, return a GoalState.
 *
 * Never throws. Storage failures collapse to a GoalState built from empty
 * inputs — the popup still renders a sensible "0 / goal" view rather than
 * an error state.
 */
export async function loadGoalState(ports?: GoalTrackerPorts): Promise<GoalState> {
  const nowFn = ports?.now ?? Date.now;
  const nowMs = (() => {
    try {
      const v = nowFn();
      return typeof v === "number" && Number.isFinite(v) ? v : Date.now();
    } catch {
      return Date.now();
    }
  })();
  const today = new Date(nowMs);
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const windowStart = new Date(startOfToday);
  windowStart.setDate(startOfToday.getDate() - (WEEK_WINDOW_DAYS - 1));

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

  const loadDay = ports?.loadDailyLog ?? storageLoadDailyLog;
  let todayLog: DailyLog;
  try {
    todayLog = await loadDay(today);
  } catch {
    todayLog = { count: 0, entries: [] };
  }
  if (!todayLog || typeof todayLog !== "object") {
    todayLog = { count: 0, entries: [] };
  }

  const loadRangeFn = ports?.loadRange ?? readLogLoadRange;
  let logsByDate: Map<string, DailyLog>;
  try {
    logsByDate = await loadRangeFn(windowStart, today);
  } catch {
    logsByDate = new Map();
  }
  if (!logsByDate) logsByDate = new Map();

  return evaluateGoalState(todayLog, logsByDate, settings, today, nowMs);
}

/**
 * Read the per-day notification flag for `today`. Returns true when today's
 * goal has been met AND we have not yet recorded that we notified for today.
 * The caller is responsible for actually firing the notification and then
 * calling markGoalMetNotificationFired() — the gate doesn't fire on its own
 * because the SPEC-mandated minimum permissions stay in the caller's hands.
 */
export async function shouldFireGoalMetNotification(
  state: GoalState,
  ports?: GoalTrackerPorts,
): Promise<boolean> {
  if (!state?.today?.met) return false;
  const nowFn = ports?.now ?? Date.now;
  let ts: number;
  try {
    const v = nowFn();
    ts = typeof v === "number" && Number.isFinite(v) ? v : Date.now();
  } catch {
    ts = Date.now();
  }
  const key = `${GOAL_MET_NOTIFICATION_KEY_PREFIX}${formatDateKey(new Date(ts))}`;
  try {
    const stored = await chrome.storage.local.get(key);
    return stored[key] !== true;
  } catch {
    return false;
  }
}

/**
 * Persist the "we already notified for today" flag. Idempotent; called by the
 * popup or background after it has actually surfaced the toast/notification.
 * Silent on write failure — the worst case is a duplicate notification next
 * time, which is preferable to a thrown exception.
 */
export async function markGoalMetNotificationFired(
  today: Date,
): Promise<void> {
  const safe =
    today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date();
  const key = `${GOAL_MET_NOTIFICATION_KEY_PREFIX}${formatDateKey(safe)}`;
  try {
    await chrome.storage.local.set({ [key]: true });
  } catch {
    // Silent — duplicate notification next call is preferable to throwing.
  }
}
