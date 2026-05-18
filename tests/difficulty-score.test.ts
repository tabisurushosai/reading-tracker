/**
 * Unit tests for pure helpers in src/difficulty-score.ts.
 */
import { describe, it, expect } from "vitest";
import {
  EASY_MAX,
  MEDIUM_MAX,
  countKanji,
  detectLanguage,
  scoreText,
  scoreToDifficulty,
  splitEnglishWords,
  splitSentences,
} from "../src/difficulty-score.js";

describe("detectLanguage", () => {
  it("returns 'ja' for Japanese-dominant text", () => {
    expect(detectLanguage("こんにちは世界、これは日本語の文章です。")).toBe("ja");
  });

  it("returns 'en' for English-dominant text", () => {
    expect(detectLanguage("The quick brown fox jumps over the lazy dog.")).toBe("en");
  });

  it("returns 'unknown' for empty input", () => {
    expect(detectLanguage("")).toBe("unknown");
  });

  it("returns 'unknown' for digits-only / whitespace text", () => {
    expect(detectLanguage("12345 67890 .... !!!!")).toBe("unknown");
  });
});

describe("countKanji", () => {
  it("counts only CJK ideographs, ignoring kana and ASCII", () => {
    expect(countKanji("日本語 abc ひらがな カタカナ 漢字")).toBe(5);
  });

  it("returns 0 for empty input", () => {
    expect(countKanji("")).toBe(0);
  });
});

describe("splitEnglishWords", () => {
  it("strips surrounding punctuation but keeps contractions and digits", () => {
    expect(splitEnglishWords("Hello, world! Don't fear 3rd parties.")).toEqual([
      "Hello",
      "world",
      "Don't",
      "3rd",
      "parties",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitEnglishWords("")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("splits on ASCII terminators", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("splits on Japanese terminators", () => {
    expect(splitSentences("一つ。二つ！三つ？")).toEqual(["一つ。", "二つ！", "三つ？"]);
  });

  it("falls back to the whole string when there is no terminator", () => {
    expect(splitSentences("no terminator here")).toEqual(["no terminator here"]);
  });
});

describe("scoreToDifficulty", () => {
  it("maps low scores to easy", () => {
    expect(scoreToDifficulty(0)).toBe("easy");
    expect(scoreToDifficulty(EASY_MAX - 0.001)).toBe("easy");
  });

  it("maps mid scores to medium", () => {
    expect(scoreToDifficulty(EASY_MAX)).toBe("medium");
    expect(scoreToDifficulty(MEDIUM_MAX - 0.001)).toBe("medium");
  });

  it("maps high scores to hard", () => {
    expect(scoreToDifficulty(MEDIUM_MAX)).toBe("hard");
    expect(scoreToDifficulty(1)).toBe("hard");
  });
});

describe("scoreText", () => {
  it("returns unknown/empty for undefined input", () => {
    const r = scoreText(undefined);
    expect(r.difficulty).toBe("unknown");
    expect(r.score).toBeNull();
    expect(r.reason).toBe("empty");
  });

  it("returns unknown/empty for whitespace-only input", () => {
    const r = scoreText("   \n   \t  ");
    expect(r.difficulty).toBe("unknown");
    expect(r.reason).toBe("empty");
  });

  it("returns unknown/too-short for samples below MIN_TEXT_FOR_SCORING", () => {
    const r = scoreText("Hi there!");
    expect(r.difficulty).toBe("unknown");
    expect(r.reason).toBe("too-short");
  });

  it("produces a numeric score and bucket for a long English sample", () => {
    const sample =
      "This is a relatively simple paragraph written in plain English. " +
      "It contains short sentences. The words are common. Readers should find it accessible. " +
      "Nothing about the content is academic, technical, or otherwise complex.";
    const r = scoreText(sample);
    expect(r.language).toBe("en");
    expect(r.score).not.toBeNull();
    expect(["easy", "medium", "hard"]).toContain(r.difficulty);
  });
});
