/**
 * monthly-report — T030 tests / integrity checks.
 *
 * Conventions match the prior T018 / T021 / T024 / T027 test files:
 *   - no test-framework imports (devDeps stay minimal),
 *   - type-checked under `npm run lint` (tsc --noEmit) via tsconfig include,
 *   - runnable ad-hoc with tsx by calling runMonthlyReportTests().
 *
 * Coverage:
 *   - pure helpers (monthOf, monthBounds, computeMonthlyTotals,
 *     computeDailyGrid, computeTopHosts, computeDifficultyMix,
 *     computeByDayOfWeek, computeMonthOverMonth, computeMonthlyStreak,
 *     evaluateMonthlyReport) via table-driven cases against synthetic
 *     DailyLog + Settings fixtures with a fixed `today`,
 *   - async seam (loadMonthlyReport) driven with an in-memory
 *     chrome.storage.local fake installed on globalThis plus MonthlyReportPorts
 *     stubs that pin `now` / loadRange.
 *
 * The pure-helper coverage drives the boundary contract the design comment in
 * monthly-report.ts promises: midnight-rollover-safe month boundaries, fully
 * pre-filled daily grid, host counting via URL parser only, locale-free
 * day-of-week bucketing, null-valued month-over-month on previous=0.
 */

import {
  formatDateKey,
  type DailyLog,
  type DailyLogEntry,
  type Settings,
} from "./storage.js";
import {
  DAYS_IN_WEEK,
  FREE_TIER_TOP_HOSTS,
  MAX_DAYS_IN_MONTH,
  computeByDayOfWeek,
  computeDailyGrid,
  computeDifficultyMix,
  computeMonthOverMonth,
  computeMonthlyStreak,
  computeMonthlyTotals,
  computeTopHosts,
  evaluateMonthlyReport,
  loadMonthlyReport,
  monthBounds,
  monthOf,
  type MonthRef,
  type MonthlyReportPorts,
} from "./monthly-report.js";

// ---------------------------------------------------------------------------
// Assertion helpers (mirrors goal-tracker.test.ts).
// ---------------------------------------------------------------------------

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[monthly-report.test] ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[monthly-report.test] ${label}`);
}

function assertClose(actual: number, expected: number, label: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    throw new Error(
      `[monthly-report.test] ${label}\n  expected ≈ ${expected}\n  actual    ${actual}`,
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
    dailyGoal: 2,
    difficultyPref: "any",
    theme: "auto",
    ...overrides,
  };
}

/**
 * Synthesize a Map<dateKey, DailyLog> for the entire calendar month of
 * `ref`. `countsByDay` maps day-of-month (1-indexed) → entry count; days
 * absent from the map have no log. Difficulty is uniform per call.
 */
function buildMonthLogs(
  ref: MonthRef,
  countsByDay: ReadonlyMap<number, number>,
  difficulty?: "easy" | "medium" | "hard",
  hostsByDay?: ReadonlyMap<number, string>,
): Map<string, DailyLog> {
  const out = new Map<string, DailyLog>();
  for (const [day, count] of countsByDay) {
    if (count <= 0) continue;
    const cursor = new Date(ref.year, ref.month, day);
    const key = formatDateKey(cursor);
    const host = hostsByDay?.get(day) ?? "x.example";
    const entries: DailyLogEntry[] = [];
    for (let i = 0; i < count; i += 1) {
      entries.push(entry(`https://${host}/${key}-${i}`, difficulty));
    }
    out.set(key, { count, entries });
  }
  return out;
}

const today = new Date(2026, 4, 17); // 2026-05-17 (May, 31 days)
const mayRef: MonthRef = { year: 2026, month: 4 };
const aprilRef: MonthRef = { year: 2026, month: 3 };

// ---------------------------------------------------------------------------
// monthOf
// ---------------------------------------------------------------------------

function checkMonthOf(): void {
  assertEqual(monthOf(today), mayRef, "monthOf: 2026-05-17 → May 2026");
  // First-of-month boundary.
  assertEqual(
    monthOf(new Date(2026, 0, 1)),
    { year: 2026, month: 0 },
    "monthOf: 2026-01-01 → Jan 2026",
  );
  // Last-of-month boundary.
  assertEqual(
    monthOf(new Date(2026, 11, 31)),
    { year: 2026, month: 11 },
    "monthOf: 2026-12-31 → Dec 2026",
  );
  // NaN → falls back to current month (we only assert it's a valid MonthRef).
  const fallback = monthOf(new Date(NaN));
  assertTrue(
    Number.isInteger(fallback.year) && fallback.month >= 0 && fallback.month <= 11,
    "monthOf: NaN → valid fallback MonthRef",
  );
  // Non-Date input (cast) → fallback.
  const fallback2 = monthOf(undefined as unknown as Date);
  assertTrue(
    Number.isInteger(fallback2.year) && fallback2.month >= 0 && fallback2.month <= 11,
    "monthOf: undefined → valid fallback MonthRef",
  );
}

// ---------------------------------------------------------------------------
// monthBounds
// ---------------------------------------------------------------------------

function checkMonthBounds(): void {
  const may = monthBounds(mayRef);
  assertEqual(may.ref, mayRef, "monthBounds: ref preserved");
  assertEqual(may.startDateKey, "2026-05-01", "monthBounds: May start key");
  assertEqual(may.endDateKey, "2026-05-31", "monthBounds: May end key");
  assertEqual(may.daysInMonth, 31, "monthBounds: May has 31 days");

  const feb = monthBounds({ year: 2026, month: 1 });
  assertEqual(feb.daysInMonth, 28, "monthBounds: Feb 2026 has 28 days (non-leap)");
  assertEqual(feb.endDateKey, "2026-02-28", "monthBounds: Feb end key");

  const febLeap = monthBounds({ year: 2024, month: 1 });
  assertEqual(febLeap.daysInMonth, 29, "monthBounds: Feb 2024 has 29 days (leap)");

  // Month overflow clamps to 11 (Dec) instead of rolling over to next year.
  const overflow = monthBounds({ year: 2026, month: 13 });
  assertEqual(overflow.ref.month, 11, "monthBounds: month=13 clamps to 11");
  assertEqual(overflow.startDateKey, "2026-12-01", "monthBounds: clamped start key");

  // Negative month clamps to 0 (Jan).
  const underflow = monthBounds({ year: 2026, month: -5 });
  assertEqual(underflow.ref.month, 0, "monthBounds: negative month clamps to 0");

  // Non-finite year falls back to current year — only assert it produces a
  // valid bound, not the exact year (depends on real Date.now()).
  const badYear = monthBounds({ year: Number.NaN as number, month: 0 });
  assertTrue(Number.isInteger(badYear.ref.year), "monthBounds: NaN year → integer fallback");
  assertEqual(badYear.daysInMonth, 31, "monthBounds: Jan still has 31 days");
}

// ---------------------------------------------------------------------------
// computeMonthlyTotals
// ---------------------------------------------------------------------------

function checkComputeMonthlyTotals(): void {
  // Empty map → zeros.
  {
    const t = computeMonthlyTotals(new Map(), monthBounds(mayRef), settings());
    assertEqual(t, { totalReads: 0, totalReadsUnfiltered: 0 }, "totals: empty map");
  }

  // Mix of in-window and out-of-window days.
  {
    const inMonth = buildMonthLogs(
      mayRef,
      new Map([
        [1, 2],
        [15, 3],
        [31, 1],
      ]),
    );
    // Inject a key from the previous month — must be skipped.
    inMonth.set("2026-04-30", log([entry("https://x.example/old")]));
    const t = computeMonthlyTotals(inMonth, monthBounds(mayRef), settings());
    assertEqual(
      t,
      { totalReads: 6, totalReadsUnfiltered: 6 },
      "totals: in-window sum (out-of-window dropped)",
    );
  }

  // difficultyPref filter — easy entries only.
  {
    const easy = buildMonthLogs(mayRef, new Map([[5, 3]]), "easy");
    const mediumExtra = buildMonthLogs(mayRef, new Map([[6, 2]]), "medium");
    const merged = new Map<string, DailyLog>([...easy, ...mediumExtra]);
    const t = computeMonthlyTotals(merged, monthBounds(mayRef), settings({ difficultyPref: "easy" }));
    assertEqual(
      t,
      { totalReads: 3, totalReadsUnfiltered: 5 },
      "totals: difficultyPref=easy filters totalReads only",
    );
  }
}

// ---------------------------------------------------------------------------
// computeDailyGrid
// ---------------------------------------------------------------------------

function checkComputeDailyGrid(): void {
  const may = monthBounds(mayRef);
  const logs = buildMonthLogs(mayRef, new Map([[1, 2], [17, 1], [20, 4]]));
  const grid = computeDailyGrid(logs, may, settings({ dailyGoal: 2 }), today);

  assertEqual(grid.length, may.daysInMonth, "grid: length = daysInMonth");

  // Day 1: count=2, met=true (goal=2), inFuture=false
  const d1 = grid[0];
  assertEqual(d1.dateKey, "2026-05-01", "grid: day 1 dateKey");
  assertEqual(d1.dayOfMonth, 1, "grid: day 1 dayOfMonth");
  assertEqual(d1.count, 2, "grid: day 1 count");
  assertEqual(d1.met, true, "grid: day 1 met");
  assertEqual(d1.inFuture, false, "grid: day 1 not in future");

  // Day 17 (today): count=1, met=false (goal=2), inFuture=false
  const d17 = grid[16];
  assertEqual(d17.dateKey, "2026-05-17", "grid: day 17 dateKey");
  assertEqual(d17.count, 1, "grid: day 17 count");
  assertEqual(d17.met, false, "grid: day 17 not met (1<2)");
  assertEqual(d17.inFuture, false, "grid: today not in future");

  // Day 18 (tomorrow): no log, inFuture=true
  const d18 = grid[17];
  assertEqual(d18.count, 0, "grid: day 18 empty count");
  assertEqual(d18.met, false, "grid: day 18 not met");
  assertEqual(d18.inFuture, true, "grid: day 18 (tomorrow) in future");

  // Day 20: count=4, met=true (over goal), inFuture=true (still after today)
  const d20 = grid[19];
  assertEqual(d20.count, 4, "grid: day 20 count");
  assertEqual(d20.met, true, "grid: day 20 met");
  assertEqual(d20.inFuture, true, "grid: day 20 in future");

  // dayOfWeek must equal Date#getDay() for that calendar day.
  // 2026-05-01 is a Friday → getDay()=5.
  assertEqual(grid[0].dayOfWeek, 5, "grid: 2026-05-01 dayOfWeek=Fri=5");
  // 2026-05-17 is a Sunday → getDay()=0.
  assertEqual(grid[16].dayOfWeek, 0, "grid: 2026-05-17 dayOfWeek=Sun=0");
}

function checkComputeDailyGridShortMonth(): void {
  // Feb 2026 has 28 days — grid must be exactly 28 cells.
  const feb = monthBounds({ year: 2026, month: 1 });
  const grid = computeDailyGrid(new Map(), feb, settings(), today);
  assertEqual(grid.length, 28, "grid: Feb non-leap → 28 cells");
  assertEqual(grid[grid.length - 1].dayOfMonth, 28, "grid: Feb last cell dayOfMonth=28");
}

function checkComputeDailyGridDifficultyPref(): void {
  const may = monthBounds(mayRef);
  const easy = buildMonthLogs(mayRef, new Map([[10, 2]]), "easy");
  const hard = buildMonthLogs(mayRef, new Map([[11, 3]]), "hard");
  const merged = new Map<string, DailyLog>([...easy, ...hard]);
  const grid = computeDailyGrid(
    merged,
    may,
    settings({ dailyGoal: 1, difficultyPref: "easy" }),
    today,
  );
  assertEqual(grid[9].count, 2, "grid: pref=easy → day 10 counts easy entries");
  assertEqual(grid[10].count, 0, "grid: pref=easy → day 11 hard entries excluded");
}

// ---------------------------------------------------------------------------
// computeTopHosts
// ---------------------------------------------------------------------------

function checkComputeTopHosts(): void {
  // Empty map → [].
  assertEqual(computeTopHosts(new Map(), monthBounds(mayRef)), [], "topHosts: empty map");

  const logs = buildMonthLogs(
    mayRef,
    new Map([[1, 2], [2, 1], [3, 2], [4, 1]]),
    undefined,
    new Map([[1, "b.example"], [2, "a.example"], [3, "c.example"], [4, "b.example"]]),
  );
  const hosts = computeTopHosts(logs, monthBounds(mayRef));
  // b: 3 (day1=2 + day4=1), a: 1, c: 2 → desc by count, asc by host on tie
  assertEqual(
    hosts,
    [
      { host: "b.example", count: 3 },
      { host: "c.example", count: 2 },
      { host: "a.example", count: 1 },
    ],
    "topHosts: desc by count, asc by host on tie",
  );

  // Unparseable URL entries are dropped.
  const broken = new Map<string, DailyLog>();
  broken.set(
    "2026-05-10",
    log([entry("not-a-url"), entry("https://valid.example/x")]),
  );
  const brokenHosts = computeTopHosts(broken, monthBounds(mayRef));
  assertEqual(
    brokenHosts,
    [{ host: "valid.example", count: 1 }],
    "topHosts: unparseable URL dropped",
  );

  // Out-of-window entries are excluded.
  const mixed = buildMonthLogs(mayRef, new Map([[1, 1]]));
  mixed.set("2026-04-30", log([entry("https://old.example/x")]));
  mixed.set("2026-06-01", log([entry("https://new.example/x")]));
  const filtered = computeTopHosts(mixed, monthBounds(mayRef));
  assertEqual(
    filtered.map((h) => h.host),
    ["x.example"],
    "topHosts: out-of-window dropped",
  );
}

// ---------------------------------------------------------------------------
// computeDifficultyMix
// ---------------------------------------------------------------------------

function checkComputeDifficultyMix(): void {
  // Empty → all zeros.
  assertEqual(
    computeDifficultyMix(new Map(), monthBounds(mayRef)),
    { easy: 0, medium: 0, hard: 0, unknown: 0 },
    "difficultyMix: empty",
  );

  // Mix of difficulties — unfiltered by settings.difficultyPref.
  const merged = new Map<string, DailyLog>([
    ...buildMonthLogs(mayRef, new Map([[1, 2]]), "easy"),
    ...buildMonthLogs(mayRef, new Map([[2, 1]]), "medium"),
    ...buildMonthLogs(mayRef, new Map([[3, 1]]), "hard"),
  ]);
  // Add an entry without difficulty (unknown bucket).
  merged.set("2026-05-04", log([entry("https://x.example/u")]));
  const mix = computeDifficultyMix(merged, monthBounds(mayRef));
  assertEqual(mix, { easy: 2, medium: 1, hard: 1, unknown: 1 }, "difficultyMix: mixed");
}

// ---------------------------------------------------------------------------
// computeByDayOfWeek
// ---------------------------------------------------------------------------

function checkComputeByDayOfWeek(): void {
  // 2026-05-01 = Friday (5), 2026-05-02 = Saturday (6), 2026-05-03 = Sunday (0)
  const logs = new Map<string, DailyLog>([
    ...buildMonthLogs(mayRef, new Map([[1, 3]])),
    ...buildMonthLogs(mayRef, new Map([[2, 2]])),
    ...buildMonthLogs(mayRef, new Map([[3, 1]])),
  ]);
  const bow = computeByDayOfWeek(logs, monthBounds(mayRef), settings());
  assertEqual(bow.counts.length, DAYS_IN_WEEK, "byDayOfWeek: 7 buckets");
  // Sun=3rd → 1, Fri=1st → 3, Sat=2nd → 2, others 0.
  assertEqual(bow.counts[0], 1, "byDayOfWeek: Sun bucket");
  assertEqual(bow.counts[5], 3, "byDayOfWeek: Fri bucket");
  assertEqual(bow.counts[6], 2, "byDayOfWeek: Sat bucket");
  for (const idx of [1, 2, 3, 4]) {
    assertEqual(bow.counts[idx], 0, `byDayOfWeek: idx=${idx} empty`);
  }

  // Corrupted key — must not throw and must not contribute.
  const corrupt = new Map<string, DailyLog>([...buildMonthLogs(mayRef, new Map([[1, 1]]))]);
  corrupt.set("garbage", log([entry("https://x.example/g")]));
  corrupt.set("2026-1a-01", log([entry("https://x.example/g2")]));
  const bow2 = computeByDayOfWeek(corrupt, monthBounds(mayRef), settings());
  assertEqual(bow2.counts[5], 1, "byDayOfWeek: corrupted keys don't break legitimate buckets");
}

function checkComputeByDayOfWeekDifficultyPref(): void {
  const easyLogs = new Map<string, DailyLog>([
    ...buildMonthLogs(mayRef, new Map([[1, 2]]), "easy"),
    ...buildMonthLogs(mayRef, new Map([[8, 3]]), "hard"),
  ]);
  // pref=easy → Fri (1st) counted (2), Fri (8th) NOT counted (hard).
  const bow = computeByDayOfWeek(easyLogs, monthBounds(mayRef), settings({ difficultyPref: "easy" }));
  assertEqual(bow.counts[5], 2, "byDayOfWeek: pref=easy filters hard out of Fri bucket");
}

// ---------------------------------------------------------------------------
// computeMonthOverMonth
// ---------------------------------------------------------------------------

function checkComputeMonthOverMonth(): void {
  const may = monthBounds(mayRef);
  const apr = monthBounds(aprilRef);

  // Both empty → totals=0, perDayCurrent=0, previous is null.
  {
    const cmp = computeMonthOverMonth(new Map(), new Map(), may, apr, settings(), today);
    assertEqual(cmp.totalCurrent, 0, "MoM: empty totalCurrent=0");
    assertEqual(cmp.totalPrevious, null, "MoM: empty previous → null");
    assertEqual(cmp.perDayPrevious, null, "MoM: previous=null → perDayPrevious=null");
    assertEqual(cmp.deltaPerDay, null, "MoM: previous=null → deltaPerDay=null");
    assertEqual(cmp.elapsedDaysCurrent, 17, "MoM: today=17 → 17 elapsed days");
  }

  // Realistic case: current=34 reads over 17 days, previous=30 reads over 30 days.
  {
    const current = buildMonthLogs(mayRef, new Map([[1, 10], [10, 14], [15, 10]]));
    // April 2026 has 30 days; spread 30 reads across April.
    const previous = buildMonthLogs(aprilRef, new Map([[1, 10], [15, 10], [30, 10]]));
    const cmp = computeMonthOverMonth(current, previous, may, apr, settings(), today);
    assertEqual(cmp.totalCurrent, 34, "MoM: totalCurrent");
    assertEqual(cmp.totalPrevious, 30, "MoM: totalPrevious");
    assertEqual(cmp.elapsedDaysCurrent, 17, "MoM: today=17");
    assertClose(cmp.perDayCurrent, 34 / 17, "MoM: perDayCurrent");
    if (cmp.perDayPrevious === null) {
      throw new Error("MoM: perDayPrevious should not be null when previous>0");
    }
    assertClose(cmp.perDayPrevious, 30 / 30, "MoM: perDayPrevious = 30/30");
    if (cmp.deltaPerDay === null) {
      throw new Error("MoM: deltaPerDay should not be null when previous>0");
    }
    assertClose(cmp.deltaPerDay, 34 / 17 - 1, "MoM: deltaPerDay");
  }

  // Today after the requested month → elapsedDaysCurrent = full month length.
  {
    const todayJun = new Date(2026, 5, 5);
    const cmp = computeMonthOverMonth(new Map(), new Map(), may, apr, settings(), todayJun);
    assertEqual(
      cmp.elapsedDaysCurrent,
      may.daysInMonth,
      "MoM: today past month → elapsed=daysInMonth",
    );
  }

  // Today before the requested month → elapsedDaysCurrent = 0, perDayCurrent = 0.
  {
    const todayBefore = new Date(2026, 3, 15); // April 15
    const cmp = computeMonthOverMonth(new Map(), new Map(), may, apr, settings(), todayBefore);
    assertEqual(cmp.elapsedDaysCurrent, 0, "MoM: future month → elapsed=0");
    assertEqual(cmp.perDayCurrent, 0, "MoM: future month → perDayCurrent=0");
  }
}

// ---------------------------------------------------------------------------
// computeMonthlyStreak
// ---------------------------------------------------------------------------

function checkComputeMonthlyStreak(): void {
  // Empty → zeros.
  assertEqual(
    computeMonthlyStreak(new Map(), monthBounds(mayRef)),
    { longestInMonth: 0, activeDays: 0 },
    "streak: empty",
  );

  // 3-day run at start, gap, 2-day run → longestInMonth=3, activeDays=5.
  {
    const logs = buildMonthLogs(
      mayRef,
      new Map([[1, 1], [2, 1], [3, 1], [10, 1], [11, 1]]),
    );
    const s = computeMonthlyStreak(logs, monthBounds(mayRef));
    assertEqual(s, { longestInMonth: 3, activeDays: 5 }, "streak: 3+2 runs");
  }

  // Single mid-month day → 1, 1.
  {
    const logs = buildMonthLogs(mayRef, new Map([[15, 5]]));
    const s = computeMonthlyStreak(logs, monthBounds(mayRef));
    assertEqual(s, { longestInMonth: 1, activeDays: 1 }, "streak: single day");
  }

  // Out-of-month entries don't contribute even if adjacent to month start.
  {
    const logs = buildMonthLogs(mayRef, new Map([[1, 1], [2, 1]]));
    // Inject April 30 — adjacent to May 1 but outside this month's window.
    logs.set("2026-04-30", log([entry("https://x.example/old")]));
    const s = computeMonthlyStreak(logs, monthBounds(mayRef));
    assertEqual(s.longestInMonth, 2, "streak: adjacent prev-month day does not extend");
    assertEqual(s.activeDays, 2, "streak: adjacent prev-month not counted as activeDay");
  }
}

// ---------------------------------------------------------------------------
// evaluateMonthlyReport
// ---------------------------------------------------------------------------

function checkEvaluateComposes(): void {
  const current = buildMonthLogs(mayRef, new Map([[1, 2], [2, 1], [17, 1]]));
  const previous = buildMonthLogs(aprilRef, new Map([[5, 3], [6, 2]]));
  const nowMs = today.getTime();
  const report = evaluateMonthlyReport(mayRef, current, previous, settings({ dailyGoal: 2 }), today, nowMs);

  assertEqual(report.ref, mayRef, "report: ref");
  assertEqual(report.bounds.daysInMonth, 31, "report: bounds.daysInMonth");
  assertEqual(report.totalReads, 4, "report: totalReads = 2+1+1");
  assertEqual(report.totalReadsUnfiltered, 4, "report: totalReadsUnfiltered");
  assertEqual(report.dailyGrid.length, 31, "report: grid length");
  assertEqual(report.byDayOfWeek.counts.length, DAYS_IN_WEEK, "report: byDayOfWeek length");
  assertEqual(report.comparison.totalCurrent, 4, "report: comparison.totalCurrent");
  assertEqual(report.comparison.totalPrevious, 5, "report: comparison.totalPrevious");
  assertEqual(report.streak.activeDays, 3, "report: streak.activeDays");
  // 1+2 run, gap, 17 → longest=2.
  assertEqual(report.streak.longestInMonth, 2, "report: streak.longestInMonth");
  assertEqual(report.evaluatedAt, nowMs, "report: evaluatedAt=now");
}

function checkEvaluateInvalidNow(): void {
  const report = evaluateMonthlyReport(
    mayRef,
    new Map(),
    new Map(),
    settings(),
    today,
    Number.NaN as unknown as number,
  );
  assertTrue(
    typeof report.evaluatedAt === "number" && Number.isFinite(report.evaluatedAt),
    "report: NaN now → finite evaluatedAt fallback",
  );
}

function checkEvaluateJanuaryPreviousMonth(): void {
  // January → previous month must roll back to December of prior year.
  const janRef: MonthRef = { year: 2026, month: 0 };
  const janToday = new Date(2026, 0, 15);
  const current = buildMonthLogs(janRef, new Map([[1, 1]]));
  const decRef: MonthRef = { year: 2025, month: 11 };
  const previous = buildMonthLogs(decRef, new Map([[31, 2]]));
  const report = evaluateMonthlyReport(janRef, current, previous, settings(), janToday, janToday.getTime());
  assertEqual(report.comparison.totalPrevious, 2, "report Jan: previous = Dec 2025");
}

// ---------------------------------------------------------------------------
// Constants integrity
// ---------------------------------------------------------------------------

function checkConstants(): void {
  if (!(Number.isInteger(MAX_DAYS_IN_MONTH) && MAX_DAYS_IN_MONTH >= 31)) {
    throw new Error(
      `[monthly-report.test] MAX_DAYS_IN_MONTH must be integer >= 31, got ${MAX_DAYS_IN_MONTH}`,
    );
  }
  if (DAYS_IN_WEEK !== 7) {
    throw new Error(
      `[monthly-report.test] DAYS_IN_WEEK must be 7, got ${DAYS_IN_WEEK}`,
    );
  }
  if (!(Number.isInteger(FREE_TIER_TOP_HOSTS) && FREE_TIER_TOP_HOSTS > 0)) {
    throw new Error(
      `[monthly-report.test] FREE_TIER_TOP_HOSTS must be positive integer, got ${FREE_TIER_TOP_HOSTS}`,
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
// Async seam — loadMonthlyReport
// ---------------------------------------------------------------------------

async function loadMonthlyReportCases(): Promise<void> {
  // Successful load: ref omitted → uses today's month; loadRange is called
  // twice (current + previous) and report composes.
  {
    const env = installStorageFake();
    try {
      env.store.set("settings", { dailyGoal: 2, difficultyPref: "any", theme: "auto" });
      const calls: { from: string; to: string }[] = [];
      const ports: MonthlyReportPorts = {
        now: () => today.getTime(),
        loadRange: async (from, to) => {
          calls.push({ from: formatDateKey(from), to: formatDateKey(to) });
          if (formatDateKey(from) === "2026-05-01") {
            return buildMonthLogs(mayRef, new Map([[1, 2], [17, 1]]));
          }
          if (formatDateKey(from) === "2026-04-01") {
            return buildMonthLogs(aprilRef, new Map([[5, 3]]));
          }
          return new Map();
        },
      };
      const report = await loadMonthlyReport(undefined, ports);
      assertEqual(report.ref, mayRef, "loadMonthlyReport: defaults to current month");
      assertEqual(report.totalReads, 3, "loadMonthlyReport: totalReads from injected range");
      assertEqual(report.comparison.totalPrevious, 3, "loadMonthlyReport: previous totalReads");
      assertTrue(
        calls.length === 2,
        `loadMonthlyReport: loadRange called twice (current+previous), got ${calls.length}`,
      );
    } finally {
      env.uninstall();
    }
  }

  // Explicit ref → used as-is, even when today is in a different month.
  {
    const env = installStorageFake();
    try {
      const nowMs = new Date(2026, 6, 4).getTime(); // July 4 — today is past the requested month
      const ports: MonthlyReportPorts = {
        now: () => nowMs,
        loadRange: async (from) => {
          if (formatDateKey(from) === "2026-05-01") {
            return buildMonthLogs(mayRef, new Map([[1, 1]]));
          }
          return new Map();
        },
      };
      const report = await loadMonthlyReport(mayRef, ports);
      assertEqual(report.ref, mayRef, "loadMonthlyReport: explicit ref respected");
      assertEqual(
        report.comparison.elapsedDaysCurrent,
        31,
        "loadMonthlyReport: past month → elapsed=daysInMonth",
      );
    } finally {
      env.uninstall();
    }
  }

  // loadRange throws → empty report (no exception).
  {
    const env = installStorageFake();
    try {
      const ports: MonthlyReportPorts = {
        now: () => today.getTime(),
        loadRange: async () => { throw new Error("boom"); },
      };
      const report = await loadMonthlyReport(mayRef, ports);
      assertEqual(report.totalReads, 0, "loadMonthlyReport: loadRange throws → totalReads=0");
      assertEqual(
        report.dailyGrid.length,
        31,
        "loadMonthlyReport: loadRange throws → still produces full grid",
      );
    } finally {
      env.uninstall();
    }
  }

  // chrome.storage.local.get failure for settings → defaults applied; no throw.
  {
    const env = installStorageFake();
    try {
      env.fail.get = true;
      const ports: MonthlyReportPorts = {
        now: () => today.getTime(),
        loadRange: async () => buildMonthLogs(mayRef, new Map([[1, 1]])),
      };
      const report = await loadMonthlyReport(mayRef, ports);
      // Default goal=1 → day 1 with count=1 is met.
      assertEqual(report.dailyGrid[0].met, true, "loadMonthlyReport: default goal=1 met");
    } finally {
      env.uninstall();
    }
  }

  // now() throwing must not bubble up.
  {
    const env = installStorageFake();
    try {
      const ports: MonthlyReportPorts = {
        now: () => { throw new Error("clock"); },
        loadRange: async () => new Map(),
      };
      const report = await loadMonthlyReport(mayRef, ports);
      assertTrue(
        typeof report.evaluatedAt === "number" && Number.isFinite(report.evaluatedAt),
        "loadMonthlyReport: now() throws → finite evaluatedAt fallback",
      );
    } finally {
      env.uninstall();
    }
  }

  // Invalid ref → falls back to current month.
  {
    const env = installStorageFake();
    try {
      const ports: MonthlyReportPorts = {
        now: () => today.getTime(),
        loadRange: async () => new Map(),
      };
      const report = await loadMonthlyReport(
        { year: Number.NaN, month: Number.NaN } as unknown as MonthRef,
        ports,
      );
      assertEqual(report.ref, mayRef, "loadMonthlyReport: invalid ref → current month");
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point — invoked from a tsx-driven runner.
// ---------------------------------------------------------------------------

export async function runMonthlyReportTests(): Promise<void> {
  checkConstants();
  checkMonthOf();
  checkMonthBounds();
  checkComputeMonthlyTotals();
  checkComputeDailyGrid();
  checkComputeDailyGridShortMonth();
  checkComputeDailyGridDifficultyPref();
  checkComputeTopHosts();
  checkComputeDifficultyMix();
  checkComputeByDayOfWeek();
  checkComputeByDayOfWeekDifficultyPref();
  checkComputeMonthOverMonth();
  checkComputeMonthlyStreak();
  checkEvaluateComposes();
  checkEvaluateInvalidNow();
  checkEvaluateJanuaryPreviousMonth();
  await loadMonthlyReportCases();
}
