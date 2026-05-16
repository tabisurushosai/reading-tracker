/**
 * read-log — T024 tests / integrity checks.
 *
 * Same conventions as article-detect.test.ts (T018) and
 * difficulty-score.test.ts (T021):
 *   - no test-framework imports (devDeps stay minimal),
 *   - type-checked under `npm run lint` (tsc --noEmit) via tsconfig include,
 *   - runnable ad-hoc with tsx by calling runReadLogTests().
 *
 * Coverage:
 *   - pure helpers (isSameDayDuplicate, groupByDifficulty, groupByHost,
 *     streakDays, summarizeLog) via table-driven cases against synthetic
 *     DailyLog fixtures — no chrome runtime needed,
 *   - async seams (recordRead, undoLastRead, loadRange) driven with an
 *     in-memory chrome.storage.local fake installed on globalThis and
 *     ReadLogPorts wired to deterministic detect/score/now stubs.
 *
 * Score / count / size assertions stay on stable contract fields so the
 * tests survive re-tuning of MAX_ENTRIES_PER_DAY or STREAK_TOLERANCE_DAYS.
 */

import type { ArticleCandidate, ArticleDetection } from "./article-detect.js";
import type { Difficulty } from "./difficulty-score.js";
import {
  DAILY_LOG_PREFIX,
  dailyLogKey,
  formatDateKey,
  type DailyLog,
  type DailyLogEntry,
} from "./storage.js";
import {
  MAX_ENTRIES_PER_DAY,
  STREAK_TOLERANCE_DAYS,
  groupByDifficulty,
  groupByHost,
  isSameDayDuplicate,
  loadRange,
  recordRead,
  streakDays,
  summarizeLog,
  undoLastRead,
  type ReadLogPorts,
} from "./read-log.js";

// ---------------------------------------------------------------------------
// Assertion helpers (mirroring the prior two test files).
// ---------------------------------------------------------------------------

type Case<T> = { name: string; run: () => T; expect: T };

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[read-log.test] ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(`[read-log.test] ${label}`);
}

// ---------------------------------------------------------------------------
// Fixture helpers — keep cases readable.
// ---------------------------------------------------------------------------

function entry(
  url: string,
  opts: Partial<Omit<DailyLogEntry, "url">> = {},
): DailyLogEntry {
  const e: DailyLogEntry = {
    url,
    title: opts.title ?? url,
    ts: opts.ts ?? 0,
  };
  if (opts.difficulty) e.difficulty = opts.difficulty;
  return e;
}

function log(entries: DailyLogEntry[]): DailyLog {
  return { count: entries.length, entries };
}

function candidate(url: string, host?: string, title?: string): ArticleCandidate {
  let derivedHost = host;
  if (!derivedHost) {
    try {
      derivedHost = new URL(url).hostname.toLowerCase();
    } catch {
      derivedHost = "";
    }
  }
  return { url, title: title ?? url, host: derivedHost };
}

// ---------------------------------------------------------------------------
// isSameDayDuplicate
// ---------------------------------------------------------------------------

const dupCases: ReadonlyArray<Case<boolean>> = [
  {
    name: "empty log → false",
    run: () => isSameDayDuplicate(log([]), candidate("https://a.example/1")),
    expect: false,
  },
  {
    name: "matching URL → true",
    run: () =>
      isSameDayDuplicate(
        log([entry("https://a.example/1"), entry("https://b.example/2")]),
        candidate("https://a.example/1"),
      ),
    expect: true,
  },
  {
    name: "different URL → false",
    run: () =>
      isSameDayDuplicate(
        log([entry("https://a.example/1")]),
        candidate("https://a.example/2"),
      ),
    expect: false,
  },
  {
    name: "case-sensitive URL compare (different casing → not dup)",
    run: () =>
      isSameDayDuplicate(
        log([entry("https://A.example/path")]),
        candidate("https://a.example/path"),
      ),
    expect: false,
  },
];

// ---------------------------------------------------------------------------
// groupByDifficulty
// ---------------------------------------------------------------------------

const diffCases: ReadonlyArray<Case<{ easy: number; medium: number; hard: number; unknown: number }>> = [
  {
    name: "empty log → all zeros",
    run: () => groupByDifficulty(log([])),
    expect: { easy: 0, medium: 0, hard: 0, unknown: 0 },
  },
  {
    name: "mixed difficulties (and one missing → unknown bucket)",
    run: () =>
      groupByDifficulty(
        log([
          entry("https://a.example/1", { difficulty: "easy" }),
          entry("https://a.example/2", { difficulty: "easy" }),
          entry("https://a.example/3", { difficulty: "medium" }),
          entry("https://a.example/4", { difficulty: "hard" }),
          entry("https://a.example/5"),
        ]),
      ),
    expect: { easy: 2, medium: 1, hard: 1, unknown: 1 },
  },
];

// ---------------------------------------------------------------------------
// groupByHost
// ---------------------------------------------------------------------------

const hostCases: ReadonlyArray<Case<{ host: string; count: number }[]>> = [
  {
    name: "empty log → []",
    run: () => groupByHost(log([])),
    expect: [],
  },
  {
    name: "drops entries with unparseable URL",
    run: () => groupByHost(log([entry("not-a-url"), entry("https://a.example/1")])),
    expect: [{ host: "a.example", count: 1 }],
  },
  {
    name: "sorts desc by count, asc by host on tie",
    run: () =>
      groupByHost(
        log([
          entry("https://b.example/1"),
          entry("https://b.example/2"),
          entry("https://a.example/1"),
          entry("https://c.example/1"),
          entry("https://c.example/2"),
        ]),
      ),
    expect: [
      { host: "b.example", count: 2 },
      { host: "c.example", count: 2 },
      { host: "a.example", count: 1 },
    ],
  },
  {
    name: "lowercases hostname",
    run: () => groupByHost(log([entry("https://EXAMPLE.com/path")])),
    expect: [{ host: "example.com", count: 1 }],
  },
];

// ---------------------------------------------------------------------------
// streakDays
// ---------------------------------------------------------------------------

function buildLogsByDate(
  today: Date,
  counts: ReadonlyArray<number>,
): Map<string, DailyLog> {
  // counts[0] is "today", counts[1] is "yesterday", etc.
  const map = new Map<string, DailyLog>();
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (const c of counts) {
    if (c > 0) {
      map.set(formatDateKey(cursor), {
        count: c,
        entries: new Array(c).fill(0).map((_, i) =>
          entry(`https://x.example/${formatDateKey(cursor)}-${i}`, { ts: i }),
        ),
      });
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return map;
}

const today = new Date(2026, 4, 17); // 2026-05-17 (matches currentDate context but value is arbitrary)

const streakCases: ReadonlyArray<Case<number>> = [
  {
    name: "no logs → 0",
    run: () => streakDays(new Map(), today),
    expect: 0,
  },
  {
    name: "today only (1 entry) → 1",
    run: () => streakDays(buildLogsByDate(today, [1]), today),
    expect: 1,
  },
  {
    name: "today missing → 0 (STREAK_TOLERANCE_DAYS=0)",
    run: () => streakDays(buildLogsByDate(today, [0, 5, 5, 5]), today),
    expect: 0,
  },
  {
    name: "3-day continuous streak",
    run: () => streakDays(buildLogsByDate(today, [1, 2, 3, 0, 5]), today),
    expect: 3,
  },
  {
    name: "invalid today (NaN) → 0",
    run: () => streakDays(buildLogsByDate(today, [1, 1, 1]), new Date(NaN)),
    expect: 0,
  },
];

// ---------------------------------------------------------------------------
// summarizeLog
// ---------------------------------------------------------------------------

const summarizeCases: ReadonlyArray<Case<{ count: number; goalMet: boolean; byDifficulty: { easy: number; medium: number; hard: number; unknown: number } }>> = [
  {
    name: "empty log + goal=1 + any → not met",
    run: () => summarizeLog(log([]), 1, "any"),
    expect: { count: 0, goalMet: false, byDifficulty: { easy: 0, medium: 0, hard: 0, unknown: 0 } },
  },
  {
    name: "any pref counts every entry; goal=3 with 3 → met",
    run: () =>
      summarizeLog(
        log([
          entry("https://a.example/1", { difficulty: "easy" }),
          entry("https://a.example/2", { difficulty: "medium" }),
          entry("https://a.example/3"),
        ]),
        3,
        "any",
      ),
    expect: { count: 3, goalMet: true, byDifficulty: { easy: 1, medium: 1, hard: 0, unknown: 1 } },
  },
  {
    name: "specific pref counts only that bucket (easy goal=2, has 1)",
    run: () =>
      summarizeLog(
        log([
          entry("https://a.example/1", { difficulty: "easy" }),
          entry("https://a.example/2", { difficulty: "medium" }),
          entry("https://a.example/3", { difficulty: "hard" }),
        ]),
        2,
        "easy",
      ),
    expect: { count: 1, goalMet: false, byDifficulty: { easy: 1, medium: 1, hard: 1, unknown: 0 } },
  },
  {
    name: "dailyGoal<=0 degrades to 1",
    run: () =>
      summarizeLog(log([entry("https://a.example/1", { difficulty: "easy" })]), 0, "any"),
    expect: { count: 1, goalMet: true, byDifficulty: { easy: 1, medium: 0, hard: 0, unknown: 0 } },
  },
];

// ---------------------------------------------------------------------------
// Constants integrity
// ---------------------------------------------------------------------------

function checkConstants(): void {
  if (!(Number.isInteger(MAX_ENTRIES_PER_DAY) && MAX_ENTRIES_PER_DAY > 0)) {
    throw new Error(
      `[read-log.test] MAX_ENTRIES_PER_DAY must be a positive integer, got ${MAX_ENTRIES_PER_DAY}`,
    );
  }
  if (!(Number.isInteger(STREAK_TOLERANCE_DAYS) && STREAK_TOLERANCE_DAYS >= 0)) {
    throw new Error(
      `[read-log.test] STREAK_TOLERANCE_DAYS must be a non-negative integer, got ${STREAK_TOLERANCE_DAYS}`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory chrome.storage.local fake (used only by async seam tests).
//
// The async functions in read-log.ts read/write chrome.storage.local directly;
// to drive them in tests we install a minimal fake on globalThis matching the
// surface they actually call (.get(null), .get(string), .set, ...). The fake
// is installed for the duration of the test pass and removed afterward so it
// can't leak into other test files.
// ---------------------------------------------------------------------------

interface StorageFakeArea {
  get(keys: null | string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

interface StorageFake {
  storage: { local: StorageFakeArea };
  tabs?: unknown;
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

function articleDetection(c: ArticleCandidate): ArticleDetection {
  return { kind: "article", article: c };
}

function asPorts(
  detect: () => Promise<ArticleDetection>,
  opts: { score?: (a: ArticleCandidate) => Promise<Difficulty | undefined>; nowTs?: number } = {},
): ReadLogPorts {
  const ports: ReadLogPorts = {
    detect,
    now: () => opts.nowTs ?? new Date(2026, 4, 17, 9, 0, 0).getTime(),
  };
  if (opts.score) ports.score = opts.score;
  return ports;
}

// ---------------------------------------------------------------------------
// Async seam — recordRead
// ---------------------------------------------------------------------------

async function recordReadCases(): Promise<void> {
  // unsupported when detect missing
  {
    const env = installStorageFake();
    try {
      const r = await recordRead(undefined as unknown as ReadLogPorts);
      assertEqual(r.kind, "unsupported", "recordRead: no ports → unsupported");
      assertTrue(env.store.size === 0, "recordRead: no write on unsupported");
    } finally {
      env.uninstall();
    }
  }

  // unsupported when detect throws
  {
    const env = installStorageFake();
    try {
      const r = await recordRead(asPorts(async () => { throw new Error("boom"); }));
      assertEqual(r.kind, "unsupported", "recordRead: detect throws → unsupported");
    } finally {
      env.uninstall();
    }
  }

  // rejected pass-through
  {
    const env = installStorageFake();
    try {
      const rejection: ArticleDetection = {
        kind: "rejected",
        reason: { kind: "rejected-host", host: "x.com" },
      };
      const r = await recordRead(asPorts(async () => rejection));
      assertEqual(r.kind, "rejected", "recordRead: rejected detect → rejected");
      assertTrue(env.store.size === 0, "recordRead: no write on rejected");
    } finally {
      env.uninstall();
    }
  }

  // logged: writes a new entry, attaches difficulty when score resolves
  {
    const env = installStorageFake();
    try {
      const c = candidate("https://a.example/1");
      const ts = new Date(2026, 4, 17, 10, 0, 0).getTime();
      const r = await recordRead(
        asPorts(async () => articleDetection(c), {
          score: async () => "medium" as const,
          nowTs: ts,
        }),
      );
      assertEqual(r.kind, "logged", "recordRead: writes new entry → logged");
      if (r.kind === "logged") {
        assertEqual(r.entry.url, c.url, "recordRead: stored url matches");
        assertEqual(r.entry.difficulty, "medium", "recordRead: difficulty attached");
        assertEqual(r.entry.ts, ts, "recordRead: ts is from ports.now()");
        assertEqual(r.log.count, 1, "recordRead: log.count=1 after first write");
      }
      const key = dailyLogKey(new Date(ts));
      assertTrue(env.store.has(key), "recordRead: writes the dailyLogKey");
    } finally {
      env.uninstall();
    }
  }

  // duplicate: second call with the same URL same day → kind=duplicate, no second write
  {
    const env = installStorageFake();
    try {
      const c = candidate("https://a.example/1");
      const ts = new Date(2026, 4, 17, 11, 0, 0).getTime();
      const ports = asPorts(async () => articleDetection(c), { nowTs: ts });
      const first = await recordRead(ports);
      assertEqual(first.kind, "logged", "recordRead dup setup: first → logged");
      const dup = await recordRead(ports);
      assertEqual(dup.kind, "duplicate", "recordRead: second same URL → duplicate");
      if (dup.kind === "duplicate") {
        assertEqual(dup.log.count, 1, "recordRead: count unchanged on duplicate");
      }
    } finally {
      env.uninstall();
    }
  }

  // score throwing must NOT abort the write — difficulty just omitted.
  {
    const env = installStorageFake();
    try {
      const c = candidate("https://a.example/2");
      const r = await recordRead(
        asPorts(async () => articleDetection(c), {
          score: async () => { throw new Error("score boom"); },
        }),
      );
      assertEqual(r.kind, "logged", "recordRead: score throws → still logged");
      if (r.kind === "logged") {
        assertEqual(r.entry.difficulty, undefined, "recordRead: difficulty omitted when score throws");
      }
    } finally {
      env.uninstall();
    }
  }

  // score returning a non-bucket value → difficulty omitted.
  {
    const env = installStorageFake();
    try {
      const c = candidate("https://a.example/3");
      const r = await recordRead(
        asPorts(async () => articleDetection(c), {
          // Cast through unknown so the test can simulate a misbehaving port.
          score: (async () => "wat") as unknown as (a: ArticleCandidate) => Promise<Difficulty | undefined>,
        }),
      );
      assertEqual(r.kind, "logged", "recordRead: bad score value → still logged");
      if (r.kind === "logged") {
        assertEqual(r.entry.difficulty, undefined, "recordRead: bad score → difficulty omitted");
      }
    } finally {
      env.uninstall();
    }
  }

  // MAX_ENTRIES_PER_DAY cap: pre-seed with the cap, log one more → oldest drops.
  {
    const env = installStorageFake();
    try {
      const ts = new Date(2026, 4, 17, 12, 0, 0).getTime();
      const key = dailyLogKey(new Date(ts));
      const seed: DailyLogEntry[] = [];
      for (let i = 0; i < MAX_ENTRIES_PER_DAY; i += 1) {
        seed.push(entry(`https://x.example/${i}`, { ts: i }));
      }
      env.store.set(key, { count: seed.length, entries: seed });
      const c = candidate("https://x.example/new");
      const r = await recordRead(asPorts(async () => articleDetection(c), { nowTs: ts }));
      assertEqual(r.kind, "logged", "recordRead cap: new entry → logged");
      if (r.kind === "logged") {
        assertEqual(r.log.count, MAX_ENTRIES_PER_DAY, "recordRead cap: total stays at MAX");
        assertEqual(
          r.log.entries[r.log.entries.length - 1].url,
          c.url,
          "recordRead cap: newest entry is appended",
        );
        assertEqual(
          r.log.entries[0].url,
          "https://x.example/1",
          "recordRead cap: oldest entry was dropped",
        );
      }
    } finally {
      env.uninstall();
    }
  }

  // chrome.storage.local.set failure → unsupported (no throw bubbles up).
  {
    const env = installStorageFake();
    try {
      env.fail.set = true;
      const c = candidate("https://a.example/fail");
      const r = await recordRead(asPorts(async () => articleDetection(c)));
      assertEqual(r.kind, "unsupported", "recordRead: storage.set fail → unsupported");
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Async seam — undoLastRead
// ---------------------------------------------------------------------------

async function undoLastReadCases(): Promise<void> {
  // empty day → null
  {
    const env = installStorageFake();
    try {
      const ts = new Date(2026, 4, 17, 13, 0, 0).getTime();
      const r = await undoLastRead(() => ts);
      assertEqual(r, null, "undoLastRead: empty day → null");
    } finally {
      env.uninstall();
    }
  }

  // removes the most recent entry
  {
    const env = installStorageFake();
    try {
      const ts = new Date(2026, 4, 17, 14, 0, 0).getTime();
      const key = dailyLogKey(new Date(ts));
      env.store.set(key, {
        count: 2,
        entries: [entry("https://a.example/1"), entry("https://a.example/2")],
      });
      const r = await undoLastRead(() => ts);
      assertTrue(r !== null, "undoLastRead: returns a log");
      if (r) {
        assertEqual(r.count, 1, "undoLastRead: count drops by 1");
        assertEqual(r.entries[0].url, "https://a.example/1", "undoLastRead: keeps older entry");
      }
      const stored = env.store.get(key) as DailyLog;
      assertEqual(stored.count, 1, "undoLastRead: persists the smaller log");
    } finally {
      env.uninstall();
    }
  }

  // storage.set failure → null
  {
    const env = installStorageFake();
    try {
      const ts = new Date(2026, 4, 17, 15, 0, 0).getTime();
      const key = dailyLogKey(new Date(ts));
      env.store.set(key, {
        count: 1,
        entries: [entry("https://a.example/1")],
      });
      env.fail.set = true;
      const r = await undoLastRead(() => ts);
      assertEqual(r, null, "undoLastRead: storage.set fail → null");
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Async seam — loadRange
// ---------------------------------------------------------------------------

async function loadRangeCases(): Promise<void> {
  // inverted range → empty map
  {
    const env = installStorageFake();
    try {
      const from = new Date(2026, 4, 17);
      const to = new Date(2026, 4, 10);
      const r = await loadRange(from, to);
      assertEqual(r.size, 0, "loadRange: inverted range → empty");
    } finally {
      env.uninstall();
    }
  }

  // NaN dates → empty map (no throw)
  {
    const env = installStorageFake();
    try {
      const r = await loadRange(new Date(NaN), new Date(NaN));
      assertEqual(r.size, 0, "loadRange: NaN dates → empty");
    } finally {
      env.uninstall();
    }
  }

  // returns only logs inside the inclusive window; skips empty days
  {
    const env = installStorageFake();
    try {
      const may10 = new Date(2026, 4, 10);
      const may15 = new Date(2026, 4, 15);
      const may17 = new Date(2026, 4, 17);
      const may20 = new Date(2026, 4, 20);
      env.store.set(dailyLogKey(may10), { count: 1, entries: [entry("https://a.example/10")] });
      env.store.set(dailyLogKey(may15), { count: 2, entries: [entry("https://a.example/15a"), entry("https://a.example/15b")] });
      env.store.set(dailyLogKey(may17), { count: 0, entries: [] });
      env.store.set(dailyLogKey(may20), { count: 1, entries: [entry("https://a.example/20")] });
      // Also stash an unrelated key — must not appear.
      env.store.set("settings", { dailyGoal: 1 });

      const r = await loadRange(may10, may17);
      assertEqual(r.size, 2, "loadRange: 2 days have data inside window (empty day skipped)");
      assertTrue(r.has(formatDateKey(may10)), "loadRange: includes from boundary");
      assertTrue(r.has(formatDateKey(may15)), "loadRange: includes middle day");
      assertTrue(!r.has(formatDateKey(may17)), "loadRange: skips empty day at to boundary");
      assertTrue(!r.has(formatDateKey(may20)), "loadRange: excludes outside window");
    } finally {
      env.uninstall();
    }
  }

  // ignores keys that don't match DAILY_LOG_PREFIX
  {
    const env = installStorageFake();
    try {
      const day = new Date(2026, 4, 17);
      env.store.set(dailyLogKey(day), { count: 1, entries: [entry("https://a.example/x")] });
      env.store.set(`${DAILY_LOG_PREFIX}not-a-date`, { count: 9, entries: [entry("https://a.example/z")] });
      // Garbage value at a valid-shaped key → normalised away (count<=0 && entries.length===0 → skipped).
      env.store.set(`${DAILY_LOG_PREFIX}2026-01-01`, null);

      const from = new Date(2026, 0, 1);
      const to = new Date(2026, 4, 17);
      const r = await loadRange(from, to);
      assertEqual(r.size, 1, "loadRange: 1 valid log in range");
      assertTrue(r.has(formatDateKey(day)), "loadRange: returns the valid day");
    } finally {
      env.uninstall();
    }
  }

  // storage.get failure → empty map
  {
    const env = installStorageFake();
    try {
      env.fail.get = true;
      const r = await loadRange(new Date(2026, 4, 1), new Date(2026, 4, 17));
      assertEqual(r.size, 0, "loadRange: storage.get fail → empty");
    } finally {
      env.uninstall();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point — call from a tsx-driven runner (see package.json T034).
// ---------------------------------------------------------------------------

export async function runReadLogTests(): Promise<void> {
  checkConstants();
  for (const c of dupCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of diffCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of hostCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of streakCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of summarizeCases) assertEqual(c.run(), c.expect, c.name);
  await recordReadCases();
  await undoLastReadCases();
  await loadRangeCases();
}
