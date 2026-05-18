/**
 * Service worker entry point for the reading-tracker extension.
 *
 * Responsibilities:
 *   - Initialize chrome.storage.local with default settings on first install.
 *   - Stamp `trial_start_ts` so the 7-day Premium trial can be calculated.
 *   - Migrate existing storage on update (no-op for v1.0.0 placeholder).
 *
 * Manifest V3 requires the service worker to complete its work quickly;
 * keep handlers small and event-driven, never use long-running loops.
 */

type ThemePref = "auto" | "light" | "dark";
type DifficultyPref = "easy" | "medium" | "hard" | "any";

interface Settings {
  schemaVersion: number;
  dailyGoal: number;
  difficultyPref: DifficultyPref;
  theme: ThemePref;
}

interface TrialState {
  trial_start_ts: number;
  premium_unlocked: boolean;
}

interface StorageUpdate {
  settings?: Settings;
  trial_start_ts?: number;
  premium_unlocked?: boolean;
}

const SCHEMA_VERSION = 1;

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  dailyGoal: 1,
  difficultyPref: "any",
  theme: "auto",
};

/**
 * Seed chrome.storage.local with defaults the first time we see it, and
 * top up any missing keys on subsequent wakes. Never throws — write errors
 * are logged so the service worker can return quickly.
 */
async function initializeStorage(reason: chrome.runtime.OnInstalledReason): Promise<void> {
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get(["settings", "trial_start_ts", "premium_unlocked"]);
  } catch (err) {
    console.error("[reading-tracker] storage read failed", err);
    return;
  }

  const next: StorageUpdate = {};

  if (!stored.settings || typeof stored.settings !== "object") {
    next.settings = DEFAULT_SETTINGS;
  } else if ((stored.settings as Settings).schemaVersion !== SCHEMA_VERSION) {
    next.settings = { ...DEFAULT_SETTINGS, ...stored.settings, schemaVersion: SCHEMA_VERSION };
  }

  if (typeof stored.trial_start_ts !== "number") {
    next.trial_start_ts = Date.now();
  }

  if (typeof stored.premium_unlocked !== "boolean") {
    next.premium_unlocked = false;
  }

  if (Object.keys(next).length > 0) {
    try {
      await chrome.storage.local.set(next);
    } catch (err) {
      console.error("[reading-tracker] storage write failed", err);
      return;
    }
  }

  console.info(`[reading-tracker] storage initialized (${reason})`);
}

chrome.runtime.onInstalled.addListener((details) => {
  initializeStorage(details.reason).catch((err) => {
    console.error("[reading-tracker] init failed", err);
  });
});

chrome.runtime.onStartup.addListener(() => {
  // Keep the worker briefly alive so missing keys (e.g., user wiped storage)
  // are repaired on the first wake after browser restart.
  initializeStorage("startup" as chrome.runtime.OnInstalledReason).catch((err) => {
    console.error("[reading-tracker] startup init failed", err);
  });
});
