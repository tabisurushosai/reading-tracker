/**
 * Unit tests for src/i18n.ts focused on the chrome-free fallback paths.
 * (DOM-walking via applyI18n is covered manually in popup/options testing.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getLocale, t } from "../src/i18n.js";

describe("t (chrome.i18n fallback)", () => {
  const original = (globalThis as Record<string, unknown>).chrome;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = original;
    }
  });

  it("returns the message key when chrome.i18n is unavailable", () => {
    expect(t("appName")).toBe("appName");
    expect(t("popup_title")).toBe("popup_title");
  });
});

describe("getLocale (chrome.i18n fallback)", () => {
  const original = (globalThis as Record<string, unknown>).chrome;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as Record<string, unknown>).chrome;
    } else {
      (globalThis as Record<string, unknown>).chrome = original;
    }
  });

  it("defaults to 'en' when chrome.i18n.getUILanguage is unavailable", () => {
    expect(getLocale()).toBe("en");
  });
});
