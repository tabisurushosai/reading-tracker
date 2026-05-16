/**
 * goal-tracker — T027 tests / integrity checks.
 *
 * Same conventions as the earlier T018 / T021 / T024 test files:
 *   - no test-framework imports,
 *   - type-checked under `npm run lint` (tsc --noEmit) via tsconfig include,
 *   - runnable ad-hoc with tsx by calling runGoalTrackerTests().
 *
 * Coverage:
 *   - pure helpers (computeGoalProgress, computeWeeklyProgress, computeStreak,
 *     evaluateGoalState) via table-driven cases against synthetic DailyLog +
 *     Settings fixtures with a fixed `today`,
 *   - async seams (loadGoalState, shouldFireGoalMetNotification,
 *     markGoalMetNotificationFired) driven with an in-memory
 *     chrome.storage.local fake installed on globalThis plus GoalTrackerPorts
 *     stubs that pin `now` / DailyLog / range loaders.
 *
 * The pure-helper coverage drives the boundary contract the design comment in
 * goal-tracker.ts promises: percent clamp [0,1], rolling 7-day window with
 * empty-day slots, streak diff===1 continuity rule, per-day notification gate.
 */

import {
  DAILY_LOG_PREFIX,
  formatDateKey,
  type DailyLog,
  type DailyLogEntry,
  type Settings,
} from "./storage.js";
import {
  GOAL_MET_NOTIFICATION_KEY_PREFIX,
  STREAK_LOOKBACK_DAYS,
  WEEK_WINDOW_DAYS,
  computeGoalProgress,
  computeStreak,
  computeWeeklyProgress,
  evaluateGoalState,
  loadGoalState,
  markGoalMetNotificationFired,
  shouldFireGoalMetNotification,
  type GoalState,
  type GoalTrackerPorts,
} from "./goal-tracker.js";

// ---------------------------------------------------------------------------
// Assertion helpers (mirrors read-log.test.ts).
// ---------------------------------------------------------------------------

type Case<T> = { name: string; run: () => T; expect: T };

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[goal-tracker.test] ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[goal-tracker.test] ${label}`);
}

function assertClose(actual: number, expected: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    throw new Error(
      `[goal-tracker.test] ${label}\n  expected ≈ ${expected}\n  actual    ${actual}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers — keep cases readable.
// ---------------------------------------------------------------------------

function entry(
  url: string,
  difficulty?: "easy" | "medium" | "hard",
): DailyLogEntry {
  const e: DailyLogEntry = { url, title: url, ts: 0 };
  if (difficulty) e.difficulty = difficulty;
  return e;
}

function log(entries: DailyLogEntry[]): DailyLog {
  return { count: entries.length, entries };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    schemaVersion: 1,
    dailyGoal: 3,
    difficultyPref: "any",
    theme: "auto",
    ...overrides,
  };
}

/** counts[0] is "today", counts[1] is "yesterday", etc. */
function buildLogsByDate(
  today: Date,
  counts: ReadonlyArray<number>,
  difficulty?: "easy" | "medium" | "hard",
): Map<string, DailyLog> {
  const map = new Map<string, DailyLog>();
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (const c of counts) {
    if (c > 0) {
      const entries: DailyLogEntry[] = new Array(c).fill(0).map((_, i) =>
        entry(`https://x.example/${formatDateKey(cursor)}-${i}`, difficulty),
      );
      map.set(formatDateKey(cursor), { count: c, entries });
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return map;
}

const today = new Date(2026, 4, 17); // 2026-05-17

// ---------------------------------------------------------------------------
// computeGoalProgress
// ---------------------------------------------------------------------------

const progressCases: ReadonlyArray<Case<{ count: number; goal: number; percent: number; met: boolean }>> = [
  {
    name: "empty log → count=0, percent=0, not met",
    run: () => {
      const p = computeGoalProgress(log([]), settings({ dailyGoal: 3 }));
      return { count: p.count, goal: p.goal, percent: p.percent, met: p.met };
    },
    expect: { count: 0, goal: 3, percent: 0, met: false },
  },
  {
    name: "exact match — count=goal → percent=1, met",
    run: () => {
      const p = computeGoalProgress(
        log([entry("https://a/1"), entry("https://a/2"), entry("https://a/3")]),
        settings({ dailyGoal: 3 }),
      );
      return { count: p.count, goal: p.goal, percent: p.percent, met: p.met };
    },
    expect: { count: 3, goal: 3, percent: 1, met: true },
  },
  {
    name: "over-shoot is clamped to percent=1, count reported raw",
    run: () => {
      const p = computeGoalProgress(
        log([entry("https://a/1"), entry("https://a/2"), entry("https://a/3"), entry("https://a/4"), entry("https://a/5")]),
        settings({ dailyGoal: 2 }),
      );
      return { count: p.count, goal: p.goal, percent: p.percent, met: p.met };
    },
    expect: { count: 5, goal: 2, percent: 1, met: true },
  },
  {
    name: "specific difficultyPref filters count",
    run: () => {
      const p = computeGoalProgress(
        log([
          entry("https://a/1", "easy"),
          entry("https://a/2", "medium"),
          entry("https://a/3", "hard"),
        ]),
        settings({ dailyGoal: 2, difficultyPref: "hard" }),
      );
      return { count: p.count, goal: p.goal, percent: p.percent, met: p.met };
    },
    expect: { count: 1, goal: 2, percent: 0.5, met: false },
  },
  {
    name: "dailyGoal<=0 degrades to 1 (no NaN/Infinity)",
    run: () => {
      const p = computeGoalProgress(
        log([entry("https://a/1")]),
        settings({ dailyGoal: 0 }),
      );
      return { count: p.count, goal: p.goal, percent: p.percent, met: p.met };
    },
    expect: { count: 1, goal: 1, percent: 1, met: true },
  },
];

function checkProgressByDifficulty(): void {
  const p = computeGoalProgress(
    log([
      entry("https://a/1", "easy"),
      entry("https://a/2", "easy"),
      entry("https://a/3", "medium"),
      entry("https://a/4"),
    ]),
    settings({ dailyGoal: 5, difficultyPref: "any" }),
  );
  assertEqual(
    p.byDifficulty,
    { easy: 2, medium: 1, hard: 0, unknown: 1 },
    "computeGoalProgress: byDifficulty mirrors unfiltered breakdown",
  );
}

// Fractional percent — kept out of the JSON.stringify-based table to avoid
// floating-point round-trip noise.
function checkProgressFractionalPercent(): void {
  const p = computeGoalProgress(
    log([entry("https://a/1")]),
    settings({ dailyGoal: 4 }),
  );
  assertClose(p.percent, 0.25, "computeGoalProgress: 1/4 = 0.25");
  assertTrue(!p.met, "computeGoalProgress: 1/4 not met");
}

// ---------------------------------------------------------------------------
// computeWeeklyProgress
// ---------------------------------------------------------------------------

function checkWeeklyLengthAndOrder(): void {
  const m = buildLogsByDate(today, [3, 2, 0, 0, 3, 3, 3]);
  const w = computeWeeklyProgress(m, settings({ dailyGoal: 3 }), today);
  assertEqual(w.totalDays, WEEK_WINDOW_DAYS, "computeWeeklyProgress: totalDays=WEEK_WINDOW_DAYS");
  assertEqual(w.perDay.length, WEEK_WINDOW_DAYS, "computeWeeklyProgress: perDay length");
  // Oldest → newest ordering: last slot must be today.
  assertEqual(
    w.perDay[w.perDay.length - 1].date,
    formatDateKey(today),
    "computeWeeklyProgress: last slot is today",
  );
  assertEqual(w.endDate, formatDateKey(today), "computeWeeklyProgress: endDate=today");
  // startDate = today - (WEEK_WINDOW_DAYS - 1) days
  const startCursor = new Date(today);
  startCursor.setDate(today.getDate() - (WEEK_WINDOW_DAYS - 1));
  assertEqual(
    w.startDate,
    formatDateKey(startCursor),
    "computeWeeklyProgress: startDate = today - 6 days",
  );
}

function checkWeeklyEmptyMapFill(): void {
  const w = computeWeeklyProgress(new Map(), settings({ dailyGoal: 1 }), today);
  assertEqual(w.perDay.length, WEEK_WINDOW_DAYS, "computeWeeklyProgress: empty map still produces full window");
  assertEqual(w.daysMet, 0, "computeWeeklyProgress: empty map → daysMet=0");
  for (const slot of w.perDay) {
    assertEqual(slot.count, 0, `computeWeeklyProgress: empty slot count=0 (${slot.date})`);
    assertEqual(slot.met, false, `computeWeeklyProgress: empty slot met=false (${slot.date})`);
  }
}

function checkWeeklyDaysMet(): void {
  // today=3 (met), -1=2 (not met), -4=3 (met), -5=3 (met), -6=3 (met) → 4 met
  const m = buildLogsByDate(today, [3, 2, 0, 0, 3, 3, 3]);
  const w = computeWeeklyProgress(m, settings({ dailyGoal: 3 }), today);
  assertEqual(w.daysMet, 4, "computeWeeklyProgress: daysMet counts slots with count>=goal");
}

function checkWeeklyDifficultyPref(): void {
  // Two easy + one medium today; goal=2, pref=easy → met
  const m = new Map<string, DailyLog>();
  m.set(
    formatDateKey(today),
    log([entry("https://a/1", "easy"), entry("https://a/2", "easy"), entry("https://a/3", "medium")]),
  );
  const w = computeWeeklyProgress(m, settings({ dailyGoal: 2, difficultyPref: "easy" }), today);
  const todaySlot = w.perDay[w.perDay.length - 1];
  assertEqual(todaySlot.count, 2, "computeWeeklyProgress: pref=easy counts only easy");
  assertEqual(todaySlot.met, true, "computeWeeklyProgress: pref=easy met");

  // pref=hard → 0 easy entries qualify
  const w2 = computeWeeklyProgress(m, settings({ dailyGoal: 1, difficultyPref: "hard" }), today);
  const todaySlot2 = w2.perDay[w2.perDay.length - 1];
  assertEqual(todaySlot2.count, 0, "computeWeeklyProgress: pref=hard counts only hard");
  assertEqual(todaySlot2.met, false, "computeWeeklyProgress: pref=hard not met");
}

function checkWeeklyInvalidToday(): void {
  // NaN today must not throw; falls back to "now" but still produces a 7-slot window.
  const w = computeWeeklyProgress(new Map(), settings(), new Date(NaN));
  assertEqual(w.perDay.length, WEEK_WINDOW_DAYS, "computeWeeklyProgress: NaN today still produces window");
}

// ---------------------------------------------------------------------------
// computeStreak
// ---------------------------------------------------------------------------

function checkStreakEmpty(): void {
  const s = computeStreak(new Map(), today);
  assertEqual(s, { current: 0, longest: 0, todayMet: false }, "computeStreak: empty map");
}

function checkStreakTodayOnly(): void {
  const s = computeStreak(buildLogsByDate(today, [1]), today);
  assertEqual(s.current, 1, "computeStreak: today only → current=1");
  assertEqual(s.longest, 1, "computeStreak: today only → longest=1");
  assertEqual(s.todayMet, true, "computeStreak: today only → todayMet");
}

function checkStreakContinuous(): void {
  // 3-day run including today
  const s = computeStreak(buildLogsByDate(today, [1, 1, 1, 0, 1, 1]), today);
  assertEqual(s.current, 3, "computeStreak: 3-day current");
  assertEqual(s.longest, 3, "computeStreak: longest=3 (current >= older 2-day run)");
  assertEqual(s.todayMet, true, "computeStreak: today met");
}

function checkStreakLongestPriorRun(): void {
  // today=1 (current=1), older 4-day run separated by a gap → longest=4
  const s = computeStreak(buildLogsByDate(today, [1, 0, 1, 1, 1, 1]), today);
  assertEqual(s.current, 1, "computeStreak: gap right after today → current=1");
  assertEqual(s.longest, 4, "computeStreak: longest finds older 4-day run");
}

function checkStreakTodayMissing(): void {
  const s = computeStreak(buildLogsByDate(today, [0, 1, 1, 1]), today);
  assertEqual(s.current, 0, "computeStreak: today missing → current=0 (STREAK_TOLERANCE_DAYS=0)");
  assertEqual(s.longest, 3, "computeStreak: longest still finds older 3-day run");
  assertEqual(s.todayMet, false, "computeStreak: today missing → todayMet=false");
}

function checkStreakCorruptedKeys(): void {
  // Mixed in a malformed key — must not throw and must not extend a run.
  const m = buildLogsByDate(today, [1, 1, 1]);
  m.set("garbage-key", { count: 5, entries: [entry("https://x/y")] });
  m.set("2026-1a-01", { count: 5, entries: [entry("https://x/z")] });
  const s = computeStreak(m, today);
  assertEqual(s.current, 3, "computeStreak: corrupted keys don't break current");
  assertEqual(s.longest, 3, "computeStreak: corrupted keys don't break longest");
}

function checkStreakInvalidToday(): void {
  // NaN today → falls back to new Date(), which won't match the fixture map,
  // so current degrades to 0 but the walk over longest still runs without throw.
  const s = computeStreak(buildLogsByDate(today, [1, 1, 1]), new Date(NaN));
  assertEqual(s.longest, 3, "computeStreak: NaN today still computes longest");
}

// ---------------------------------------------------------------------------
// evaluateGoalState
// ---------------------------------------------------------------------------

function checkEvaluateComposes(): void {
  const todayLog = log([entry("https://a/1"), entry("https://a/2")]);
  const logsByDate = buildLogsByDate(today, [2, 2, 0, 1]);
  const set = settings({ dailyGoal: 2 });
  const nowMs = 1700000000000;
  const state = evaluateGoalState(todayLog, logsByDate, set, today, nowMs);
  assertEqual(state.today.count, 2, "evaluateGoalState: today.count");
  assertEqual(state.today.met, true, "evaluateGoalState: today.met");
  assertEqual(state.evaluatedAt, nowMs, "evaluateGoalState: evaluatedAt=now");
  assertEqual(state.week.totalDays, WEEK_WINDOW_DAYS, "evaluateGoalState: week.totalDays");
  assertEqual(state.streak.current, 2, "evaluateGoalState: streak.current=2");
}

function checkEvaluateInvalidNow(): void {
  const state = evaluateGoalState(
    log([]),
    new Map(),
    settings(),
    today,
    Number.NaN as unknown as number,
  );
  assertTrue(
    typeof state.evaluatedAt === "number" && Number.isFinite(state.evaluatedAt),
    "evaluateGoalState: NaN now → finite fallback",
  );
}

// ---------------------------------------------------------------------------
// Constants integrity
// ---------------------------------------------------------------------------

function checkConstants(): void {
  if (!(Number.isInteger(WEEK_WINDOW_DAYS) && WEEK_WINDOW_DAYS > 0)) {
    throw new Error(
      `[goal-tracker.test] WEEK_WINDOW_DAYS must be positive integer, got ${WEEK_WINDOW_DAYS}`,
    );
  }
  if (!(Number.isInteger(STREAK_LOOKBACK_DAYS) && STREAK_LOOKBACK_DAYS > 0)) {
    throw new Error(
      `[goal-tracker.test] STREAK_LOOKBACK_DAYS must be positive integer, got ${STREAK_LOOKBACK_DAYS}`,
    );
  }
  if (typeof GOAL_MET_NOTIFICATION_KEY_PREFIX !== "string" || !GOAL_MET_NOTIFICATION_KEY_PREFIX) {
    throw new Error(
      `[goal-tracker.test] GOAL_MET_NOTIFICATION_KEY_PREFIX must be non-empty string`,
    );
  }
  if (GOAL_MET_NOTIFICATION_KEY_PREFIX.startsWith(DAILY_LOG_PREFIX)) {
    throw new Error(
      `[goal-tracker.test] notification key prefix must not collide with daily log prefix`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local fake (used by async seam tests).
// ---------------------------------------------------------------------------

interface StorageFakeArea {
  get(keys: null | string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

interface StorageFake {
  storage: { local: StorageFakeArea };
}

function installStorageFake(): {
  store: Map<string, unknown>;
  uninstall: () => void;
  fail: { set: boolean; get: boolean };
} {
  const store = new Map<string, unknown>();
  const fail = { set: false, get: false };
  const area: StorageFakeArea = {
    async get(keys) {
      if (fail.get) throw new Error("get fail");
      if (keys === null || keys === undefined) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of store) out[k] = v;
        return out;
      }
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    async set(items) {
      if (fail.set) throw new Error("set fail");
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async clear() {
      store.clear();
    },
  };
  const fake: StorageFake = { storage: { local: area } };
  const g = globalThis as unknown as { chrome?: unknown };
  const prev = g.chrome;
  g.chrome = fake;
  return {
    store,
    fail,
    uninstall: () => {
      g.chrome = prev;
    },
  };
}

// ---------------------------------------------------------------------------
// Async seam — loadGoalState
// ---------------------------------------------------------------------------

async function loadGoalStateCases(): Promise<void> {
  // Successful load: pings settings → loadDailyLog → loadRange and composes.
  {
    const env = installStorageFake();
    try {
      env.store.set("settings", { dailyGoal: 2, difficultyPref: "any", theme: "auto" });
      const nowMs = today.getTime();
      const todayLog = log([entry("https://a/1"), entry("https://a/2")]);
      const logsByDate = buildLogsByDate(today, [2, 1, 1]);
      const ports: GoalTrackerPorts = {
        now: () => nowMs,
        loadDailyLog: async () => todayLog,
        loadRange: async () => logsByDate,
      };
      const state = await loadGoalState(ports);
      assertEqual(state.today.count, 2, "loadGoalState: today.count from injected log");
      assertEqual(state.today.goal, 2, "loadGoalState: goal from settings");
      assertEqual(state.today.met, true, "loadGoalState: met=true on 2/2");
      assertEqual(state.streak.current, 3, "loadGoalState: streak.current from injected range");
    } finally {
      env.uninstall();
    }
  }

  // No settings stored → defaults to dailyGoal=1, pref=any.
  {
    const env = installStorageFake();
    try {
      const nowMs = today.getTime();
      const ports: GoalTrackerPorts = {
        now: () => nowMs,
        loadDailyLog: async () => log([entry("https://a/1")]),
        loadRange: async () => new Map(),
      };
      const state = await loadGoalState(ports);
      assertEqual(state.today.goal, 1, "loadGoalState: missing settings → goal=1");
      assertEqual(state.today.met, true, "loadGoalState: 1 entry meets default goal=1");
    } finally {
      env.uninstall();
    }
  }

  // loadDailyLog throws → zero-count state, no exception.
  {
    const env = installStorageFake();
    try {
      const nowMs = today.getTime();
      const ports: GoalTrackerPorts = {
        now: () => nowMs,
        loadDailyLog: async () => { throw new Error("boom"); },
        loadRange: async () => new Map(),
      };
      const state = await loadGoalState(ports);
      assertEqual(state.today.count, 0, "loadGoalState: loadDailyLog throws → count=0");
      assertEqual(state.today.met, false, "loadGoalState: loadDailyLog throws → not met");
    } finally {
      env.uninstall();
    }
  }

  // loadRange throws → empty week + zero streak, no exception.
  {
    const env = installStorageFake();
    try {
      const nowMs = today.getTime();
      const ports: GoalTrackerPorts = {
        now: () => nowMs,
        loadDailyLog: async () => log([]),
        loadRange: async () => { throw new Error("boom"); },
      };
      const state = await loadGoalState(ports);
      assertEqual(state.streak.current, 0, "loadGoalState: loadRange throws → streak.current=0");
      assertEqual(state.week.daysMet, 0, "loadGoalState: loadRange throws → daysMet=0");
      assertEqual(state.week.totalDays, WEEK_WINDOW_DAYS, "loadGoalState: still full window");
    } finally {
      env.uninstall();
    }
  }

  // chrome.storage.local.get failure for settings → defaults applied; no throw.
  {
    const env = installStorageFake();
    try {
      env.fail.get = true;
      const nowMs = today.getTime();
      const ports: GoalTrackerPorts = {
        now: () => nowMs,
        loadDailyLog: async () => log([]),
        loadRange: async () => new Map(),
      };
      const state = await loadGoalState(ports);
      assertEqual(state.today.goal, 1, "loadGoalState: settings get fail → default goal");
    } finally {
      env.uninstall();
    }
  }

  // now() throwing must not bubble up.
  {
    const env = installStorageFake();
    try {
      const ports: GoalTrackerPorts = {
        now: () => { throw new Error("clock"); },
        loadDailyLog: async () => log([]),
        loadRange: async () => new Map(),
      };
      const state = await loadGoalState(ports);
      assertTrue(
        typeof state.evaluatedAt === "number" && Number.isFinite(state.evaluatedAt),
        "loadGoalState: now() throws → finite evaluatedAt fallback",
      );
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Async seam — shouldFireGoalMetNotification / markGoalMetNotificationFired
// ---------------------------------------------------------------------------

function metState(met: boolean): GoalState {
  return {
    today: {
      count: met ? 1 : 0,
      goal: 1,
      percent: met ? 1 : 0,
      met,
      byDifficulty: { easy: 0, medium: 0, hard: 0, unknown: met ? 1 : 0 },
    },
    week: {
      startDate: formatDateKey(today),
      endDate: formatDateKey(today),
      daysMet: 0,
      totalDays: WEEK_WINDOW_DAYS,
      perDay: [],
    },
    streak: { current: 0, longest: 0, todayMet: false },
    evaluatedAt: today.getTime(),
  };
}

async function shouldFireCases(): Promise<void> {
  // not met → never fire
  {
    const env = installStorageFake();
    try {
      const fire = await shouldFireGoalMetNotification(metState(false), { now: () => today.getTime() });
      assertEqual(fire, false, "shouldFire: not met → false");
    } finally {
      env.uninstall();
    }
  }

  // met, no flag yet → fire
  {
    const env = installStorageFake();
    try {
      const fire = await shouldFireGoalMetNotification(metState(true), { now: () => today.getTime() });
      assertEqual(fire, true, "shouldFire: met, no flag → true");
    } finally {
      env.uninstall();
    }
  }

  // met, flag already set for today → suppress
  {
    const env = installStorageFake();
    try {
      const key = `${GOAL_MET_NOTIFICATION_KEY_PREFIX}${formatDateKey(today)}`;
      env.store.set(key, true);
      const fire = await shouldFireGoalMetNotification(metState(true), { now: () => today.getTime() });
      assertEqual(fire, false, "shouldFire: flag set → suppress");
    } finally {
      env.uninstall();
    }
  }

  // storage.get failure → false (never duplicate-notify on a flaky read)
  {
    const env = installStorageFake();
    try {
      env.fail.get = true;
      const fire = await shouldFireGoalMetNotification(metState(true), { now: () => today.getTime() });
      assertEqual(fire, false, "shouldFire: storage.get fail → false");
    } finally {
      env.uninstall();
    }
  }

  // markGoalMetNotificationFired writes the per-day key.
  {
    const env = installStorageFake();
    try {
      await markGoalMetNotificationFired(today);
      const key = `${GOAL_MET_NOTIFICATION_KEY_PREFIX}${formatDateKey(today)}`;
      assertEqual(env.store.get(key), true, "mark: per-day flag persisted");
    } finally {
      env.uninstall();
    }
  }

  // markGoalMetNotificationFired swallows storage.set failures.
  {
    const env = installStorageFake();
    try {
      env.fail.set = true;
      // Must not throw.
      await markGoalMetNotificationFired(today);
    } finally {
      env.uninstall();
    }
  }

  // Round-trip: after mark, shouldFire returns false.
  {
    const env = installStorageFake();
    try {
      await markGoalMetNotificationFired(today);
      const fire = await shouldFireGoalMetNotification(metState(true), { now: () => today.getTime() });
      assertEqual(fire, false, "shouldFire: after mark → false (no duplicate)");
    } finally {
      env.uninstall();
    }
  }

  // Invalid Date passed to mark → falls back to today (no throw).
  {
    const env = installStorageFake();
    try {
      await markGoalMetNotificationFired(new Date(NaN));
      // Any key with the prefix should now exist.
      let foundPrefix = false;
      for (const k of env.store.keys()) {
        if (k.startsWith(GOAL_MET_NOTIFICATION_KEY_PREFIX)) {
          foundPrefix = true;
          break;
        }
      }
      assertTrue(foundPrefix, "mark: NaN date → still writes a per-day flag");
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point — invoked from a tsx-driven runner.
// ---------------------------------------------------------------------------

export async function runGoalTrackerTests(): Promise<void> {
  checkConstants();
  for (const c of progressCases) {
    const got = c.run();
    assertEqual(got, c.expect, c.name);
  }
  checkProgressByDifficulty();
  checkProgressFractionalPercent();
  checkWeeklyLengthAndOrder();
  checkWeeklyEmptyMapFill();
  checkWeeklyDaysMet();
  checkWeeklyDifficultyPref();
  checkWeeklyInvalidToday();
  checkStreakEmpty();
  checkStreakTodayOnly();
  checkStreakContinuous();
  checkStreakLongestPriorRun();
  checkStreakTodayMissing();
  checkStreakCorruptedKeys();
  checkStreakInvalidToday();
  checkEvaluateComposes();
  checkEvaluateInvalidNow();
  await loadGoalStateCases();
  await shouldFireCases();
}
