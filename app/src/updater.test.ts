import { beforeEach, describe, expect, it } from "vitest";
import {
  markUpdateNoticeDismissed,
  parseHighlights,
  shouldShowNoticeFor,
} from "./updater";

beforeEach(() => {
  localStorage.clear();
});

describe("parseHighlights()", () => {
  it("returns [] for empty / null input", () => {
    expect(parseHighlights("")).toEqual([]);
    expect(parseHighlights(undefined)).toEqual([]);
    expect(parseHighlights(null)).toEqual([]);
  });

  it("extracts dash bullets", () => {
    const body = "- one\n- two\n- three";
    expect(parseHighlights(body)).toEqual(["one", "two", "three"]);
  });

  it("extracts asterisk and plus bullets", () => {
    const body = "* one\n+ two";
    expect(parseHighlights(body)).toEqual(["one", "two"]);
  });

  it("ignores non-bullet lines", () => {
    const body = "## What's new\n\n- bullet\nrandom prose\n- another";
    expect(parseHighlights(body)).toEqual(["bullet", "another"]);
  });

  it("strips inline code, bold, italic, links", () => {
    const body =
      "- fix `bug` here\n" +
      "- **bold** matters\n" +
      "- *italic* too\n" +
      "- a [link](https://x.com) too";
    expect(parseHighlights(body)).toEqual([
      "fix bug here",
      "bold matters",
      "italic too",
      "a link too",
    ]);
  });

  it("caps at 4 bullets", () => {
    const body = "- 1\n- 2\n- 3\n- 4\n- 5\n- 6";
    expect(parseHighlights(body).length).toBe(4);
  });

  it("drops bullets longer than 140 chars", () => {
    const body = "- " + "x".repeat(141) + "\n- short";
    expect(parseHighlights(body)).toEqual(["short"]);
  });

  it("handles CRLF line endings", () => {
    const body = "- one\r\n- two\r\n";
    expect(parseHighlights(body)).toEqual(["one", "two"]);
  });

  it("trims whitespace around bullet content", () => {
    expect(parseHighlights("-   spaced out   ")).toEqual(["spaced out"]);
  });
});

describe("update notice dismissal", () => {
  it("shouldShowNoticeFor is true initially", () => {
    expect(shouldShowNoticeFor("1.2.3")).toBe(true);
  });

  it("markUpdateNoticeDismissed silences that version", () => {
    markUpdateNoticeDismissed("1.2.3");
    expect(shouldShowNoticeFor("1.2.3")).toBe(false);
  });

  it("a newer version still shows even if older was dismissed", () => {
    markUpdateNoticeDismissed("1.2.3");
    expect(shouldShowNoticeFor("1.2.4")).toBe(true);
  });
});
