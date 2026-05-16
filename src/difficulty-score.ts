/**
 * difficulty-score — design skeleton (T019)
 *
 * Purpose
 * ───────
 * Turn the sampled body text from article-detect (T016–T018) into a coarse
 * difficulty bucket the rest of the app can store and aggregate:
 *   - read-log (T022–T024)     — persists Difficulty alongside each entry
 *   - goal-tracker (T025–T027) — filters progress by Settings.difficultyPref
 *   - monthly-report (T028–)   — groups counts by difficulty
 *
 * Target audience reminder (SPEC.md "ターゲット")
 *   - 不登校児 / 発達特性児 — wants visible "easy → medium → hard" progression.
 *   - 英語圏 Homeschool 市場 — same scale must apply to English prose too.
 * The same three-bucket scale therefore has to work across Japanese and English
 * without requiring a model download or any network call. Everything below is
 * deliberately heuristic, offline, and cheap enough to run inside the popup
 * service-worker tick.
 *
 * Why a single Difficulty type instead of a numeric grade level?
 *   - DifficultyPref in storage.ts already uses "easy" / "medium" / "hard".
 *     Keeping the score module aligned with that vocabulary avoids needing a
 *     translation table at every UI boundary.
 *   - Children + non-specialist parents read three buckets faster than a
 *     Flesch–Kincaid number. We still expose the raw numeric score for the
 *     monthly-report drill-down view.
 *
 * Scoring strategy
 * ────────────────
 * Two-tier, language-dispatched:
 *
 *   1. detectLanguage(text) picks "ja" | "en" | "unknown"
 *      - Counts Japanese-script characters (hiragana + katakana + kanji)
 *        vs. ASCII letters; whichever exceeds a threshold wins.
 *      - Falls back to "unknown" when the sample is too short or mixed; the
 *        score then degrades to Difficulty="medium" rather than guessing.
 *
 *   2. Per-language metric:
 *        Japanese  → kanji ratio + average sentence length (in characters).
 *                    High kanji density correlates with adult / academic prose.
 *        English   → average word length + average sentence length (in words).
 *                    Approximates Flesch's idea without needing syllable tables.
 *
 *      Each metric is normalised to a 0–1 "complexity" value, then blended with
 *      fixed weights into the final score. Thresholds below split [0, 1] into
 *      easy / medium / hard. Numbers are tunable in T020 once we have real
 *      sample pages to calibrate against — chosen here so the obvious cases
 *      (a children's blog vs. a research abstract) land in the right bucket.
 *
 * Privacy / SPEC.md compliance
 * ────────────────────────────
 *   - Pure synchronous functions over an already-sampled string. No fetch, no
 *     storage write, no DOM access. The text never leaves the popup's JS heap.
 *   - extractArticleBody() in article-detect.ts caps the sample at
 *     MAX_BODY_SAMPLE_CHARS (4096), so worst-case runtime is bounded.
 *
 * Failure mode
 * ────────────
 *   - scoreText("") and scoreText(undefined) return { difficulty: "unknown",
 *     score: null, language: "unknown", reason: "empty" }. Callers MUST handle
 *     "unknown" — read-log will simply omit the difficulty field rather than
 *     guess, so monthly-report can show "未分類" buckets honestly.
 *   - scoreArticle(candidate) is the convenience wrapper: when candidate.text
 *     is missing it returns the same "unknown" result without throwing.
 *
 * Test surface (T021)
 * ───────────────────
 *   - Each pure helper (detectLanguage, countKanji, splitEnglishWords,
 *     splitSentences, scoreToDifficulty, scoreText) is exported individually
 *     so T021 can run a table-driven test under tsx without a chrome runtime.
 *   - Calibration fixtures will live alongside the test file, not here, so
 *     bumping thresholds doesn't require rewriting the design doc.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Three-bucket scale shared with storage.DifficultyPref (minus "any"). */
export type Difficulty = "easy" | "medium" | "hard";

/** Detected script family. "unknown" means the sample was too short / mixed. */
export type Language = "ja" | "en" | "unknown";

/**
 * Raw, language-specific measurements feeding the final score. Exposed so
 * monthly-report (T028–) can display a "why was this rated hard?" breakdown
 * without re-running the scorer.
 */
export interface TextMetrics {
  /** Characters considered for scoring (post-whitespace-collapse). */
  charCount: number;
  /** Sentences detected by splitSentences(). */
  sentenceCount: number;
  /** Average sentence length — characters for "ja", words for "en". */
  avgSentenceLength: number;
  /** Average word length in characters (English only; 0 for ja/unknown). */
  avgWordLength: number;
  /** Kanji ratio in [0, 1] (Japanese only; 0 for en/unknown). */
  kanjiRatio: number;
}

/**
 * Result of scoring a body sample. `score` is null when language is "unknown"
 * or the sample was rejected (too short). Callers MUST guard on `difficulty`
 * — "unknown" means "do not persist a difficulty field for this entry".
 */
export interface DifficultyScore {
  difficulty: Difficulty | "unknown";
  /** Blended 0–1 complexity, or null when not scorable. */
  score: number | null;
  language: Language;
  metrics: TextMetrics;
  /** Short tag explaining a non-"easy/medium/hard" result for debugging. */
  reason?: "empty" | "too-short" | "ok";
}

// ---------------------------------------------------------------------------
// Tuning constants — calibrated in T020, frozen in T021's test fixtures.
// ---------------------------------------------------------------------------

/** Below this many post-trim characters we return "unknown" instead of guessing. */
export const MIN_TEXT_FOR_SCORING = 50;

/** Score boundaries. score < EASY_MAX → easy; < MEDIUM_MAX → medium; else hard. */
export const EASY_MAX = 0.34;
export const MEDIUM_MAX = 0.67;

/**
 * Japanese metric normalisation anchors. A kanji ratio of 0.40 (≈ academic
 * prose) maps to 1.0; an average sentence ≥ 80 characters maps to 1.0.
 * Anchors are conservative — children's books typically sit well under 0.15
 * kanji and < 25-char sentences, comfortably in "easy".
 */
export const JA_KANJI_RATIO_FULL = 0.4;
export const JA_AVG_SENTENCE_FULL = 80;

/**
 * English metric anchors. Avg word length ≥ 6.5 chars and avg sentence ≥ 25
 * words map to 1.0. Approximates Flesch reading-ease "hard" region without
 * shipping a syllable dictionary.
 */
export const EN_AVG_WORD_FULL = 6.5;
export const EN_AVG_SENTENCE_WORDS_FULL = 25;

/** Blend weights — must sum to 1.0 per language. */
export const JA_WEIGHT_KANJI = 0.6;
export const JA_WEIGHT_SENTENCE = 0.4;
export const EN_WEIGHT_WORD = 0.55;
export const EN_WEIGHT_SENTENCE = 0.45;

// ---------------------------------------------------------------------------
// Pure helpers — T020 implements, T021 tests
// ---------------------------------------------------------------------------

/**
 * Detect the dominant script. Returns "unknown" when neither Japanese-script
 * nor ASCII-letter characters reach a usable share of the sample.
 *
 * Counts:
 *   - Japanese: U+3040–309F (hiragana) + U+30A0–30FF (katakana) +
 *               U+4E00–9FFF (CJK unified ideographs).
 *   - English: ASCII letters A–Z, a–z. Digits and punctuation excluded so
 *              code listings or tables of numbers don't flip detection.
 */
export function detectLanguage(text: string): Language {
  throw new Error("difficulty-score.detectLanguage: not implemented (T020)");
}

/** Count CJK unified ideograph (kanji) characters in `text`. */
export function countKanji(text: string): number {
  throw new Error("difficulty-score.countKanji: not implemented (T020)");
}

/**
 * Split English prose into whitespace-separated word tokens, stripped of
 * surrounding punctuation. Numbers and contractions are kept (don't, 3rd).
 */
export function splitEnglishWords(text: string): string[] {
  throw new Error("difficulty-score.splitEnglishWords: not implemented (T020)");
}

/**
 * Split into sentence-like spans. Handles both ASCII (. ! ?) and Japanese
 * (。 ！ ？) terminators. Falls back to the whole string when no terminator
 * is present so avgSentenceLength stays defined.
 */
export function splitSentences(text: string): string[] {
  throw new Error("difficulty-score.splitSentences: not implemented (T020)");
}

/** Map a [0, 1] score into the three-bucket scale using EASY_MAX / MEDIUM_MAX. */
export function scoreToDifficulty(score: number): Difficulty {
  throw new Error("difficulty-score.scoreToDifficulty: not implemented (T020)");
}

/**
 * Score a body sample end-to-end. Returns { difficulty: "unknown" } when the
 * input is empty, too short, or language is undetectable. Never throws.
 */
export function scoreText(text: string | undefined): DifficultyScore {
  throw new Error("difficulty-score.scoreText: not implemented (T020)");
}

// ---------------------------------------------------------------------------
// Convenience wrapper for the article-detect → read-log pipeline
// ---------------------------------------------------------------------------

/**
 * Score an ArticleCandidate's optional .text. Lives here (not in
 * article-detect) so the scoring rules stay co-located with the metric
 * constants; article-detect remains responsible only for sampling.
 *
 * When candidate.text is undefined (the user clicked "log" without granting
 * activeTab body extraction, or extraction returned null), the result is
 * { difficulty: "unknown", reason: "empty" } — callers should persist the
 * entry without a difficulty field rather than fabricate one.
 */
export function scoreArticle(candidate: { text?: string }): DifficultyScore {
  throw new Error("difficulty-score.scoreArticle: not implemented (T020)");
}
