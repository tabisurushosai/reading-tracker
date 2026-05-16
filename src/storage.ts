/**
 * Typed wrapper around chrome.storage.local.
 *
 * Acts as the single source of truth for the extension's persisted shapes
 * (Settings, DailyLog, TrialState) and their default values. Callers should
 * prefer these helpers over raw chrome.storage.local.get/set so the schema
 * stays consistent across popup, options, background, and future modules.
 *
 * Design notes:
 *   - Keys are namespaced strings ("settings", "trial_start_ts",
 *     "premium_unlocked", "daily_log_YYYY-MM-DD") so the storage area can be
 *     enumerated by prefix when reports are generated (T028–T030).
 *   - Loaders always merge stored values with defaults so a partial or
 *     stale-schema record does not crash callers.
 *   - All functions return Promises and never throw on missing keys; that
 *     matches chrome.storage's own contract and keeps UI code simple.
 */

export type ThemePref = "auto" | "light" | "dark";
export type DifficultyPref = "easy" | "medium" | "hard" | "any";

export interface Settings {
  schemaVersion: number;
  dailyGoal: number;
  difficultyPref: DifficultyPref;
  theme: ThemePref;
}

export interface DailyLogEntry {
  url: string;
  title: string;
  ts: number;
  difficulty?: Exclude<DifficultyPref, "any">;
}

export interface DailyLog {
  count: number;
  entries: DailyLogEntry[];
}

export interface TrialState {
  trial_start_ts: number;
  premium_unlocked: boolean;
}

export const SCHEMA_VERSION = 1;
export const TRIAL_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_LOG_PREFIX = "daily_log_";

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  dailyGoal: 1,
  difficultyPref: "any",
  theme: "auto",
};

// ---------------------------------------------------------------------------
// Date helpers (date-key formatting is part of the storage contract — every
// caller must agree on the exact key string for a given calendar day).
// ---------------------------------------------------------------------------

/** Format a Date as `YYYY-MM-DD` in the local timezone (matches popup UX). */
export function formatDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Storage key for a given calendar day's read log. */
export function dailyLogKey(date: Date = new Date()): string {
  return `${DAILY_LOG_PREFIX}${formatDateKey(date)}`;
}

// ---------------------------------------------------------------------------
// Validators / normalizers — guard against partial or hand-edited storage.
// ---------------------------------------------------------------------------

function isDifficultyPref(v: unknown): v is DifficultyPref {
  return v === "easy" || v === "medium" || v === "hard" || v === "any";
}

function isThemePref(v: unknown): v is ThemePref {
  return v === "auto" || v === "light" || v === "dark";
}

/** Clamp the daily goal into [1, 100] and coerce to an integer. */
export function clampDailyGoal(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.dailyGoal;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function normalizeSettings(stored: unknown): Settings {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_SETTINGS };
  const s = stored as Partial<Settings>;
  return {
    schemaVersion: SCHEMA_VERSION,
    dailyGoal: clampDailyGoal(s.dailyGoal),
    difficultyPref: isDifficultyPref(s.difficultyPref) ? s.difficultyPref : DEFAULT_SETTINGS.difficultyPref,
    theme: isThemePref(s.theme) ? s.theme : DEFAULT_SETTINGS.theme,
  };
}

function normalizeDailyLog(stored: unknown): DailyLog {
  if (!stored || typeof stored !== "object") return { count: 0, entries: [] };
  const log = stored as Partial<DailyLog>;
  const entries = Array.isArray(log.entries)
    ? log.entries.filter((e): e is DailyLogEntry =>
        !!e && typeof e === "object" && typeof (e as DailyLogEntry).url === "string"
      )
    : [];
  const count = typeof log.count === "number" && log.count >= 0 ? log.count : entries.length;
  return { count, entries };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return normalizeSettings(settings);
}

export async function saveSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: normalizeSettings(next) });
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const merged = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

// ---------------------------------------------------------------------------
// Trial / Premium state
// ---------------------------------------------------------------------------

export async function loadTrialState(): Promise<TrialState> {
  const { trial_start_ts, premium_unlocked } = await chrome.storage.local.get([
    "trial_start_ts",
    "premium_unlocked",
  ]);
  return {
    trial_start_ts: typeof trial_start_ts === "number" ? trial_start_ts : Date.now(),
    premium_unlocked: premium_unlocked === true,
  };
}

export async function setPremiumUnlocked(unlocked: boolean): Promise<void> {
  await chrome.storage.local.set({ premium_unlocked: unlocked });
}

/** Days remaining in the 7-day trial. 0 once the trial has elapsed. */
export function trialDaysRemaining(state: TrialState, now: number = Date.now()): number {
  if (state.premium_unlocked) return Number.POSITIVE_INFINITY;
  const elapsed = now - state.trial_start_ts;
  return Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsed) / DAY_MS));
}

/** True if the user currently has Premium access (paid or in trial window). */
export function hasPremiumAccess(state: TrialState, now: number = Date.now()): boolean {
  if (state.premium_unlocked) return true;
  return now - state.trial_start_ts < TRIAL_DAYS * DAY_MS;
}

// ---------------------------------------------------------------------------
// Daily read log
// ---------------------------------------------------------------------------

export async function loadDailyLog(date: Date = new Date()): Promise<DailyLog> {
  const key = dailyLogKey(date);
  const stored = await chrome.storage.local.get(key);
  return normalizeDailyLog(stored[key]);
}

export async function appendDailyLog(entry: DailyLogEntry, date: Date = new Date()): Promise<DailyLog> {
  const key = dailyLogKey(date);
  const current = await loadDailyLog(date);
  const next: DailyLog = {
    count: current.count + 1,
    entries: [...current.entries, entry],
  };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

/** Enumerate every `daily_log_*` key currently in storage, newest first. */
export async function listDailyLogKeys(): Promise<string[]> {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(DAILY_LOG_PREFIX))
    .sort()
    .reverse();
}

// ---------------------------------------------------------------------------
// Backup / restore / reset
// ---------------------------------------------------------------------------

export async function exportAll(): Promise<Record<string, unknown>> {
  return chrome.storage.local.get(null);
}

export async function importAll(data: Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(data);
}

/** Wipe storage and re-seed defaults so the next popup open is not broken. */
export async function resetAll(now: number = Date.now()): Promise<void> {
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS },
    trial_start_ts: now,
    premium_unlocked: false,
  });
}
