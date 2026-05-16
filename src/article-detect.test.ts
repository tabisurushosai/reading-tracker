/**
 * article-detect — T018 tests / integrity checks.
 *
 * No external test framework is installed (the project deliberately keeps
 * devDeps minimal), so this file is a self-contained assertion suite that
 *   - type-checks under `npm run lint` (tsc --noEmit) via tsconfig include,
 *   - can be executed ad-hoc with any ESM-aware runner (tsx / node --import tsx)
 *     by calling runArticleDetectTests().
 *
 * The suite covers only the pure helpers (classifyUrl, isRejectedHost,
 * pickDisplayTitle, MAX_BODY_SAMPLE_CHARS bound) — the chrome.* integration
 * points (detectActiveArticle, extractArticleBody) are exercised manually in
 * the popup during the same task.
 */

import {
  MAX_BODY_SAMPLE_CHARS,
  classifyUrl,
  isRejectedHost,
  pickDisplayTitle,
} from "./article-detect.js";

type Case<T> = { name: string; run: () => T; expect: T };

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[article-detect.test] ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

const classifyCases: ReadonlyArray<Case<ReturnType<typeof classifyUrl>>> = [
  {
    name: "https article URL → candidate",
    run: () => classifyUrl("https://example.com/posts/123"),
    expect: { kind: "candidate", host: "example.com" },
  },
  {
    name: "http article URL → candidate (lowercased host)",
    run: () => classifyUrl("http://Example.COM/x"),
    expect: { kind: "candidate", host: "example.com" },
  },
  {
    name: "chrome:// → unsupported-scheme",
    run: () => classifyUrl("chrome://settings/"),
    expect: { kind: "unsupported-scheme", scheme: "chrome:" },
  },
  {
    name: "file:// → unsupported-scheme",
    run: () => classifyUrl("file:///etc/hosts"),
    expect: { kind: "unsupported-scheme", scheme: "file:" },
  },
  {
    name: "data: → unsupported-scheme",
    run: () => classifyUrl("data:text/plain,hello"),
    expect: { kind: "unsupported-scheme", scheme: "data:" },
  },
  {
    name: "garbage input → unsupported-scheme (invalid)",
    run: () => classifyUrl("not a url"),
    expect: { kind: "unsupported-scheme", scheme: "invalid" },
  },
  {
    name: "undefined → unsupported-scheme (invalid)",
    run: () => classifyUrl(undefined),
    expect: { kind: "unsupported-scheme", scheme: "invalid" },
  },
  {
    name: "youtube.com → rejected-host",
    run: () => classifyUrl("https://youtube.com/watch?v=abc"),
    expect: { kind: "rejected-host", host: "youtube.com" },
  },
  {
    name: "m.youtube.com → rejected-host via subdomain rule",
    run: () => classifyUrl("https://m.youtube.com/feed"),
    expect: { kind: "rejected-host", host: "m.youtube.com" },
  },
  {
    name: "x.com → rejected-host",
    run: () => classifyUrl("https://x.com/someone/status/1"),
    expect: { kind: "rejected-host", host: "x.com" },
  },
  {
    name: "notyoutube.com → candidate (no false subdomain match)",
    run: () => classifyUrl("https://notyoutube.com/post"),
    expect: { kind: "candidate", host: "notyoutube.com" },
  },
];

const rejectedHostCases: ReadonlyArray<Case<boolean>> = [
  { name: "empty host → false", run: () => isRejectedHost(""), expect: false },
  { name: "exact match", run: () => isRejectedHost("twitter.com"), expect: true },
  { name: "subdomain match", run: () => isRejectedHost("www.reddit.com"), expect: true },
  { name: "deep subdomain match", run: () => isRejectedHost("a.b.tiktok.com"), expect: true },
  {
    name: "lookalike host does not match (suffix without dot)",
    run: () => isRejectedHost("faketwitter.com"),
    expect: false,
  },
  {
    name: "case-insensitive",
    run: () => isRejectedHost("WWW.YouTube.com"),
    expect: true,
  },
  {
    name: "unrelated host",
    run: () => isRejectedHost("blog.example.com"),
    expect: false,
  },
];

const titleCases: ReadonlyArray<Case<string>> = [
  {
    name: "non-empty title is trimmed",
    run: () => pickDisplayTitle("  Hello  ", "https://example.com/"),
    expect: "Hello",
  },
  {
    name: "empty title falls back to URL",
    run: () => pickDisplayTitle("   ", "https://example.com/x"),
    expect: "https://example.com/x",
  },
  {
    name: "undefined title falls back to URL",
    run: () => pickDisplayTitle(undefined, "https://example.com/y"),
    expect: "https://example.com/y",
  },
];

export function runArticleDetectTests(): void {
  for (const c of classifyCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of rejectedHostCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of titleCases) assertEqual(c.run(), c.expect, c.name);
  if (MAX_BODY_SAMPLE_CHARS <= 0 || MAX_BODY_SAMPLE_CHARS > 1 << 16) {
    throw new Error(
      `[article-detect.test] MAX_BODY_SAMPLE_CHARS out of sane bounds: ${MAX_BODY_SAMPLE_CHARS}`
    );
  }
}
