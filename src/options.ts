/**
 * Options page entry point.
 *
 * Lets the user view and edit settings persisted in chrome.storage.local
 * (daily goal, target difficulty, theme), shows Premium/trial status, and
 * exposes basic data-management actions (export/import/reset).
 *
 * Premium gating (T031–T033) will harden the export/import paths later.
 * For now they perform plain JSON dump / restore so the UI is functional.
 */

import { applyI18n, getLocale, t } from "./i18n.js";

type ThemePref = "auto" | "light" | "dark";
type DifficultyPref = "easy" | "medium" | "hard" | "any";

interface Settings {
  schemaVersion: number;
  dailyGoal: number;
  difficultyPref: DifficultyPref;
  theme: ThemePref;
}

const SCHEMA_VERSION = 1;
const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  dailyGoal: 1,
  difficultyPref: "any",
  theme: "auto",
};

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[options] missing element #${id}`);
  return el as T;
}

async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  if (settings && typeof settings === "object") {
    return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings>) };
  }
  return DEFAULT_SETTINGS;
}

async function saveSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ settings: next });
}

function clampGoal(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SETTINGS.dailyGoal;
  return Math.min(100, Math.max(1, Math.floor(raw)));
}

function isDifficultyPref(v: string): v is DifficultyPref {
  return v === "easy" || v === "medium" || v === "hard" || v === "any";
}

function isThemePref(v: string): v is ThemePref {
  return v === "auto" || v === "light" || v === "dark";
}

function applyTheme(theme: ThemePref): void {
  const root = document.documentElement;
  if (theme === "auto") {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "light dark";
  } else {
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }
}

function renderForm(settings: Settings): void {
  $<HTMLInputElement>("daily-goal").value = String(settings.dailyGoal);
  $<HTMLSelectElement>("difficulty-pref").value = settings.difficultyPref;
  $<HTMLSelectElement>("theme").value = settings.theme;
}

function readForm(prev: Settings): Settings {
  const goalRaw = Number($<HTMLInputElement>("daily-goal").value);
  const diff = $<HTMLSelectElement>("difficulty-pref").value;
  const theme = $<HTMLSelectElement>("theme").value;
  return {
    schemaVersion: SCHEMA_VERSION,
    dailyGoal: clampGoal(goalRaw),
    difficultyPref: isDifficultyPref(diff) ? diff : prev.difficultyPref,
    theme: isThemePref(theme) ? theme : prev.theme,
  };
}

function flashSaved(): void {
  const msg = $<HTMLElement>("saved-message");
  msg.hidden = false;
  window.setTimeout(() => {
    msg.hidden = true;
  }, 1600);
}

async function renderPremiumStatus(): Promise<void> {
  const { trial_start_ts, premium_unlocked } = await chrome.storage.local.get([
    "trial_start_ts",
    "premium_unlocked",
  ]);
  const status = $<HTMLParagraphElement>("premium-status");
  const unlockBtn = $<HTMLButtonElement>("premium-unlock-btn");

  if (premium_unlocked === true) {
    status.textContent = t("options_premium_active");
    unlockBtn.hidden = true;
    return;
  }

  const startedAt = typeof trial_start_ts === "number" ? trial_start_ts : Date.now();
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, Math.ceil((TRIAL_DAYS * DAY_MS - elapsed) / DAY_MS));

  if (remaining > 0) {
    status.textContent = t("options_trial_remaining", String(remaining));
    unlockBtn.hidden = false;
  } else {
    status.textContent = "";
    unlockBtn.hidden = false;
  }
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the download can finalize on slow browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function handleExport(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const filename = `reading-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  downloadJson(filename, all);
}

async function handleImportFile(file: File): Promise<void> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    window.alert("Invalid JSON file.");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    window.alert("Invalid backup format.");
    return;
  }
  await chrome.storage.local.set(parsed as Record<string, unknown>);
  window.location.reload();
}

async function handleReset(): Promise<void> {
  if (!window.confirm(t("options_reset_confirm"))) return;
  await chrome.storage.local.clear();
  // Re-seed defaults so the next popup open is not broken.
  await chrome.storage.local.set({
    settings: DEFAULT_SETTINGS,
    trial_start_ts: Date.now(),
    premium_unlocked: false,
  });
  window.location.reload();
}

async function init(): Promise<void> {
  document.documentElement.lang = getLocale().split("-")[0] || "en";
  applyI18n(document);

  let settings = await loadSettings();
  applyTheme(settings.theme);
  renderForm(settings);
  await renderPremiumStatus();

  $<HTMLFormElement>("settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    settings = readForm(settings);
    await saveSettings(settings);
    applyTheme(settings.theme);
    renderForm(settings);
    flashSaved();
  });

  $<HTMLButtonElement>("export-btn").addEventListener("click", () => {
    handleExport().catch((err) => console.error("[options] export failed", err));
  });

  const fileInput = $<HTMLInputElement>("import-file");
  $<HTMLButtonElement>("import-btn").addEventListener("click", () => {
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) {
      handleImportFile(file).catch((err) => console.error("[options] import failed", err));
    }
  });

  $<HTMLButtonElement>("reset-btn").addEventListener("click", () => {
    handleReset().catch((err) => console.error("[options] reset failed", err));
  });

  $<HTMLButtonElement>("premium-unlock-btn").addEventListener("click", () => {
    // Stripe Checkout integration is wired up in T033. Stub no-op for now.
    console.info("[options] premium unlock requested (pending T033)");
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => {
    console.error("[options] init failed", err);
  });
});
