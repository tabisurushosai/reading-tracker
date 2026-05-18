/**
 * Unit tests for pure helpers in src/article-detect.ts.
 * The async detectActiveArticle / extractArticleBody surfaces depend on
 * chrome.* and are out of scope here.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_BODY_SAMPLE_CHARS,
  classifyUrl,
  isRejectedHost,
  pickDisplayTitle,
} from "../src/article-detect.js";

describe("classifyUrl", () => {
  it("classifies https article URLs as candidate with lowercased host", () => {
    expect(classifyUrl("https://Example.COM/path")).toEqual({
      kind: "candidate",
      host: "example.com",
    });
  });

  it("classifies chrome:// as unsupported-scheme", () => {
    expect(classifyUrl("chrome://settings/")).toEqual({
      kind: "unsupported-scheme",
      scheme: "chrome:",
    });
  });

  it("classifies invalid input as unsupported-scheme/invalid", () => {
    expect(classifyUrl("not a url")).toEqual({
      kind: "unsupported-scheme",
      scheme: "invalid",
    });
    expect(classifyUrl(undefined)).toEqual({
      kind: "unsupported-scheme",
      scheme: "invalid",
    });
  });

  it("classifies rejected hosts (e.g., youtube subdomain)", () => {
    expect(classifyUrl("https://m.youtube.com/feed")).toEqual({
      kind: "rejected-host",
      host: "m.youtube.com",
    });
  });
});

describe("isRejectedHost", () => {
  it("matches exact reject-list hosts", () => {
    expect(isRejectedHost("twitter.com")).toBe(true);
  });

  it("matches subdomains of reject-list hosts", () => {
    expect(isRejectedHost("www.reddit.com")).toBe(true);
    expect(isRejectedHost("a.b.tiktok.com")).toBe(true);
  });

  it("does not match lookalike hosts without the leading dot boundary", () => {
    expect(isRejectedHost("faketwitter.com")).toBe(false);
    expect(isRejectedHost("blog.example.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isRejectedHost("WWW.YouTube.com")).toBe(true);
  });

  it("returns false for empty host", () => {
    expect(isRejectedHost("")).toBe(false);
  });
});

describe("pickDisplayTitle", () => {
  it("trims a non-empty title", () => {
    expect(pickDisplayTitle("  Hello  ", "https://example.com/")).toBe("Hello");
  });

  it("falls back to the URL when title is empty or undefined", () => {
    expect(pickDisplayTitle("   ", "https://example.com/x")).toBe("https://example.com/x");
    expect(pickDisplayTitle(undefined, "https://example.com/y")).toBe(
      "https://example.com/y"
    );
  });
});

describe("MAX_BODY_SAMPLE_CHARS", () => {
  it("stays inside a sane range so storage and scoring remain bounded", () => {
    expect(MAX_BODY_SAMPLE_CHARS).toBeGreaterThan(0);
    expect(MAX_BODY_SAMPLE_CHARS).toBeLessThanOrEqual(1 << 16);
  });
});
