/**
 * difficulty-score — T021 tests / integrity checks.
 *
 * Mirrors the conventions established by article-detect.test.ts (T018):
 *   - no test framework imports (devDeps deliberately minimal),
 *   - type-checks under `npm run lint` (tsc --noEmit) via tsconfig include,
 *   - runnable ad-hoc with tsx by calling runDifficultyScoreTests().
 *
 * Coverage focuses on the pure helpers (detectLanguage, countKanji,
 * splitEnglishWords, splitSentences, scoreToDifficulty) plus the two public
 * entry points (scoreText, scoreArticle). The end-to-end cases assert only
 * the stable contract fields — difficulty bucket, language, reason — and
 * leave the exact 0–1 score number free to move when T020's thresholds are
 * re-tuned against real fixtures.
 */

import {
  EASY_MAX,
  EN_AVG_SENTENCE_WORDS_FULL,
  EN_AVG_WORD_FULL,
  EN_WEIGHT_SENTENCE,
  EN_WEIGHT_WORD,
  JA_AVG_SENTENCE_FULL,
  JA_KANJI_RATIO_FULL,
  JA_WEIGHT_KANJI,
  JA_WEIGHT_SENTENCE,
  MEDIUM_MAX,
  MIN_TEXT_FOR_SCORING,
  countKanji,
  detectLanguage,
  scoreArticle,
  scoreText,
  scoreToDifficulty,
  splitEnglishWords,
  splitSentences,
  type DifficultyScore,
  type Language,
} from "./difficulty-score.js";

type Case<T> = { name: string; run: () => T; expect: T };

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`[difficulty-score.test] ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertContains(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string
): void {
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k];
    if (JSON.stringify(a) !== JSON.stringify(v)) {
      throw new Error(
        `[difficulty-score.test] ${label}\n  field "${k}" expected ${JSON.stringify(v)}, got ${JSON.stringify(a)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

const languageCases: ReadonlyArray<Case<Language>> = [
  { name: "empty → unknown", run: () => detectLanguage(""), expect: "unknown" },
  {
    name: "pure digits → unknown (no scriptable chars)",
    run: () => detectLanguage("12345 67890"),
    expect: "unknown",
  },
  {
    name: "plain ASCII prose → en",
    run: () => detectLanguage("Hello world, this is English."),
    expect: "en",
  },
  {
    name: "hiragana only → ja",
    run: () => detectLanguage("これはにほんごのぶんしょうです。"),
    expect: "ja",
  },
  {
    name: "kanji + hiragana → ja",
    run: () => detectLanguage("今日は良い天気ですね。"),
    expect: "ja",
  },
  {
    name: "katakana only → ja",
    run: () => detectLanguage("コーヒーとケーキ"),
    expect: "ja",
  },
  {
    name: "mixed but ja-dominant → ja",
    run: () => detectLanguage("今日は HTML を学ぶ良い機会です。"),
    expect: "ja",
  },
  {
    name: "mixed but en-dominant → en",
    run: () => detectLanguage("Learning HTML today is fun (たまに kanji)."),
    expect: "en",
  },
];

// ---------------------------------------------------------------------------
// countKanji
// ---------------------------------------------------------------------------

const kanjiCases: ReadonlyArray<Case<number>> = [
  { name: "empty → 0", run: () => countKanji(""), expect: 0 },
  { name: "ascii only → 0", run: () => countKanji("hello world"), expect: 0 },
  { name: "hiragana only → 0", run: () => countKanji("ひらがなだけ"), expect: 0 },
  { name: "katakana only → 0", run: () => countKanji("カタカナダケ"), expect: 0 },
  { name: "三 kanji string → 3", run: () => countKanji("日本語"), expect: 3 },
  {
    // 今,日,良,天,気 = 5 kanji; remaining chars are hiragana and excluded.
    name: "mixed kanji + kana → counts kanji only",
    run: () => countKanji("今日は良い天気ですね"),
    expect: 5,
  },
];

// ---------------------------------------------------------------------------
// splitEnglishWords
// ---------------------------------------------------------------------------

const englishWordCases: ReadonlyArray<Case<string[]>> = [
  { name: "empty → []", run: () => splitEnglishWords(""), expect: [] },
  {
    name: "single sentence",
    run: () => splitEnglishWords("Hello world"),
    expect: ["Hello", "world"],
  },
  {
    name: "strips surrounding punctuation",
    run: () => splitEnglishWords("  don't, stop. now!  "),
    expect: ["don't", "stop", "now"],
  },
  {
    name: "keeps numbers and contractions",
    run: () => splitEnglishWords("It's the 3rd time."),
    expect: ["It's", "the", "3rd", "time"],
  },
  {
    name: "collapses repeated whitespace",
    run: () => splitEnglishWords("a    b\tc\nd"),
    expect: ["a", "b", "c", "d"],
  },
];

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

const sentenceCases: ReadonlyArray<Case<string[]>> = [
  { name: "empty → []", run: () => splitSentences(""), expect: [] },
  { name: "whitespace only → []", run: () => splitSentences("   "), expect: [] },
  {
    name: "ascii terminators",
    run: () => splitSentences("Hello. World! Right?"),
    expect: ["Hello.", "World!", "Right?"],
  },
  {
    name: "japanese terminators",
    run: () => splitSentences("これは。文です。終わり！"),
    expect: ["これは。", "文です。", "終わり！"],
  },
  {
    name: "no terminator → single-element fallback",
    run: () => splitSentences("just a fragment"),
    expect: ["just a fragment"],
  },
];

// ---------------------------------------------------------------------------
// scoreToDifficulty — verify the EASY_MAX / MEDIUM_MAX boundaries.
// ---------------------------------------------------------------------------

const bucketCases: ReadonlyArray<Case<string>> = [
  { name: "0.0 → easy", run: () => scoreToDifficulty(0), expect: "easy" },
  {
    name: "just below EASY_MAX → easy",
    run: () => scoreToDifficulty(EASY_MAX - 1e-9),
    expect: "easy",
  },
  {
    name: "at EASY_MAX → medium",
    run: () => scoreToDifficulty(EASY_MAX),
    expect: "medium",
  },
  {
    name: "just below MEDIUM_MAX → medium",
    run: () => scoreToDifficulty(MEDIUM_MAX - 1e-9),
    expect: "medium",
  },
  {
    name: "at MEDIUM_MAX → hard",
    run: () => scoreToDifficulty(MEDIUM_MAX),
    expect: "hard",
  },
  { name: "1.0 → hard", run: () => scoreToDifficulty(1), expect: "hard" },
];

// ---------------------------------------------------------------------------
// scoreText / scoreArticle — contract checks (avoid asserting exact score).
// ---------------------------------------------------------------------------

function partial(
  result: DifficultyScore,
  keys: Array<keyof DifficultyScore>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = result[k];
  return out;
}

interface ScoreCase {
  name: string;
  run: () => DifficultyScore;
  expect: Partial<Pick<DifficultyScore, "difficulty" | "language" | "reason" | "score">>;
}

const longJapaneseEasy =
  "きょうはいいてんきです。あおいそらがみえます。ことりがうたっています。たのしいいちにちでした。ありがとうございました。";
const longJapaneseHard =
  "現代社会における情報技術の急激な発展は人類の生活様式や思考形態を根本的に変容させており、特に教育分野では従来の知識伝達方法を再考する必要性が指摘されている。";
const longEnglishSimple =
  "Cat is cute. Dog is fun. We play games. We run fast. The sky is blue. Birds sing.";
const longEnglishHard =
  "Contemporary epistemological frameworks frequently underestimate phenomenological subtleties intrinsic to consciousness, particularly when interdisciplinary methodologies attempt reconciliation between empirical psychology and continental philosophical traditions.";

const scoreCases: ReadonlyArray<ScoreCase> = [
  {
    name: "empty string → unknown / empty",
    run: () => scoreText(""),
    expect: { difficulty: "unknown", language: "unknown", reason: "empty", score: null },
  },
  {
    name: "undefined → unknown / empty",
    run: () => scoreText(undefined),
    expect: { difficulty: "unknown", language: "unknown", reason: "empty", score: null },
  },
  {
    name: "whitespace-only → unknown / empty",
    run: () => scoreText("   \n\t  "),
    expect: { difficulty: "unknown", language: "unknown", reason: "empty", score: null },
  },
  {
    name: "below MIN_TEXT_FOR_SCORING → unknown / too-short",
    run: () => scoreText("Short English text."),
    expect: { difficulty: "unknown", language: "en", reason: "too-short", score: null },
  },
  {
    name: "all-hiragana kids text → easy / ja",
    run: () => scoreText(longJapaneseEasy),
    expect: { difficulty: "easy", language: "ja", reason: "ok" },
  },
  {
    name: "kanji-dense single sentence → hard / ja",
    run: () => scoreText(longJapaneseHard),
    expect: { difficulty: "hard", language: "ja", reason: "ok" },
  },
  {
    name: "short-word short-sentence English → easy / en",
    run: () => scoreText(longEnglishSimple),
    expect: { difficulty: "easy", language: "en", reason: "ok" },
  },
  {
    name: "long-word long-sentence English → hard / en",
    run: () => scoreText(longEnglishHard),
    expect: { difficulty: "hard", language: "en", reason: "ok" },
  },
];

const articleCases: ReadonlyArray<ScoreCase> = [
  {
    name: "scoreArticle with no text → unknown / empty",
    run: () => scoreArticle({}),
    expect: { difficulty: "unknown", language: "unknown", reason: "empty", score: null },
  },
  {
    name: "scoreArticle forwards text to scoreText",
    run: () => scoreArticle({ text: longJapaneseEasy }),
    expect: { difficulty: "easy", language: "ja", reason: "ok" },
  },
];

// ---------------------------------------------------------------------------
// Tuning-constant integrity — the implementation depends on these holding.
// ---------------------------------------------------------------------------

function checkConstants(): void {
  if (!(EASY_MAX > 0 && EASY_MAX < MEDIUM_MAX && MEDIUM_MAX < 1)) {
    throw new Error(
      `[difficulty-score.test] expected 0 < EASY_MAX (${EASY_MAX}) < MEDIUM_MAX (${MEDIUM_MAX}) < 1`
    );
  }
  if (MIN_TEXT_FOR_SCORING <= 0) {
    throw new Error(
      `[difficulty-score.test] MIN_TEXT_FOR_SCORING must be positive, got ${MIN_TEXT_FOR_SCORING}`
    );
  }
  const jaSum = JA_WEIGHT_KANJI + JA_WEIGHT_SENTENCE;
  const enSum = EN_WEIGHT_WORD + EN_WEIGHT_SENTENCE;
  if (Math.abs(jaSum - 1) > 1e-9) {
    throw new Error(`[difficulty-score.test] JA weights must sum to 1.0, got ${jaSum}`);
  }
  if (Math.abs(enSum - 1) > 1e-9) {
    throw new Error(`[difficulty-score.test] EN weights must sum to 1.0, got ${enSum}`);
  }
  if (JA_KANJI_RATIO_FULL <= 0 || JA_KANJI_RATIO_FULL > 1) {
    throw new Error(
      `[difficulty-score.test] JA_KANJI_RATIO_FULL out of (0,1]: ${JA_KANJI_RATIO_FULL}`
    );
  }
  if (JA_AVG_SENTENCE_FULL <= 0 || EN_AVG_WORD_FULL <= 0 || EN_AVG_SENTENCE_WORDS_FULL <= 0) {
    throw new Error(`[difficulty-score.test] normalization anchors must be positive`);
  }
}

// ---------------------------------------------------------------------------
// Entry point — call from a tsx-driven runner (see package.json T034).
// ---------------------------------------------------------------------------

export function runDifficultyScoreTests(): void {
  checkConstants();
  for (const c of languageCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of kanjiCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of englishWordCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of sentenceCases) assertEqual(c.run(), c.expect, c.name);
  for (const c of bucketCases) assertEqual(c.run(), c.expect, c.name);

  const stableKeys: Array<keyof DifficultyScore> = ["difficulty", "language", "reason", "score"];
  for (const c of scoreCases) {
    const result = c.run();
    const checked = c.expect.score === null ? stableKeys : ["difficulty", "language", "reason"];
    assertContains(
      partial(result, checked as Array<keyof DifficultyScore>),
      c.expect as Record<string, unknown>,
      c.name
    );
  }
  for (const c of articleCases) {
    const result = c.run();
    const checked = c.expect.score === null ? stableKeys : ["difficulty", "language", "reason"];
    assertContains(
      partial(result, checked as Array<keyof DifficultyScore>),
      c.expect as Record<string, unknown>,
      c.name
    );
  }
}
