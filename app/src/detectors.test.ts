import { describe, expect, it } from "vitest";
import { detect } from "./detectors";

describe("detect()", () => {
  it("returns null for empty / whitespace input", () => {
    expect(detect("")).toBeNull();
    expect(detect("   \n  ")).toBeNull();
  });

  it("returns null for plain prose", () => {
    expect(detect("Hello world")).toBeNull();
  });

  describe("URL detection", () => {
    it("detects https URL", () => {
      const d = detect("https://example.com/path?x=1#h")!;
      expect(d).not.toBeNull();
      expect(d.kind).toBe("url");
      expect(d.badge).toBe("URL");
    });

    it("detects http URL", () => {
      expect(detect("http://example.com")!.kind).toBe("url");
    });

    it("detects www-prefix URL", () => {
      expect(detect("www.example.com/foo")!.kind).toBe("url");
    });

    it("does not detect bare host without scheme/www", () => {
      expect(detect("example.com")).toBeNull();
    });

    it("Plain action emits the trimmed input", () => {
      const d = detect("https://example.com/x")!;
      expect(d.actions[0].label).toBe("Plain");
      expect(d.actions[0].transform("ignored")).toBe("https://example.com/x");
    });

    it("Markdown action uses hostname without www. prefix", () => {
      const d = detect("https://www.example.com/path?x=1")!;
      const md = d.actions.find((a) => a.label === "Markdown")!;
      expect(md.transform("")).toBe("[example.com](https://www.example.com/path?x=1)");
    });

    it("HTML <a> action uses hostname", () => {
      const d = detect("https://example.com/")!;
      const html = d.actions.find((a) => a.label === "HTML <a>")!;
      expect(html.transform("")).toBe('<a href="https://example.com/">example.com</a>');
    });

    it("No params action strips ?query and #hash", () => {
      const d = detect("https://example.com/path?x=1#h")!;
      const np = d.actions.find((a) => a.label === "No params")!;
      expect(np.transform("")).toBe("https://example.com/path");
    });

    it("normalizes www-prefix URLs to https", () => {
      const d = detect("www.example.com/foo")!;
      const md = d.actions.find((a) => a.label === "Markdown")!;
      expect(md.transform("")).toContain("https://www.example.com/foo");
    });
  });

  describe("Email detection", () => {
    it("detects basic email", () => {
      const d = detect("alice@example.com")!;
      expect(d.kind).toBe("email");
      expect(d.badge).toBe("Email");
    });

    it("rejects strings without @", () => {
      expect(detect("alice example.com")).toBeNull();
    });

    it("rejects strings without TLD", () => {
      expect(detect("alice@example")).toBeNull();
    });

    it("mailto action prefixes correctly", () => {
      const d = detect("alice@example.com")!;
      const mt = d.actions.find((a) => a.label === "mailto:")!;
      expect(mt.transform("")).toBe("mailto:alice@example.com");
    });

    it("Markdown action emits mailto link", () => {
      const d = detect("alice@example.com")!;
      const md = d.actions.find((a) => a.label === "Markdown")!;
      expect(md.transform("")).toBe("[alice@example.com](mailto:alice@example.com)");
    });
  });

  describe("Hex color detection", () => {
    it("detects 6-digit hex with #", () => {
      const d = detect("#FC4C02")!;
      expect(d.kind).toBe("color");
    });

    it("detects 6-digit hex without #", () => {
      expect(detect("FC4C02")!.kind).toBe("color");
    });

    it("detects 3-digit hex and expands", () => {
      const d = detect("#abc")!;
      const hexAct = d.actions.find((a) => a.label === "#hex")!;
      expect(hexAct.transform("")).toBe("#aabbcc");
    });

    it("detects 4-digit hex (alpha) and uses first 6 of expanded", () => {
      const d = detect("abcd")!;
      const hexAct = d.actions.find((a) => a.label === "#hex")!;
      expect(hexAct.transform("")).toBe("#aabbcc");
    });

    it("detects 8-digit hex (with alpha)", () => {
      const d = detect("#aabbccdd")!;
      const hexAct = d.actions.find((a) => a.label === "#hex")!;
      expect(hexAct.transform("")).toBe("#aabbcc");
    });

    it("rgb() action emits valid CSS", () => {
      const d = detect("#FC4C02")!;
      const rgb = d.actions.find((a) => a.label === "rgb()")!;
      expect(rgb.transform("")).toBe("rgb(252, 76, 2)");
    });

    it("hsl() action emits valid CSS", () => {
      const d = detect("#FC4C02")!;
      const hsl = d.actions.find((a) => a.label === "hsl()")!;
      expect(hsl.transform("")).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
    });

    it("rejects invalid hex length", () => {
      expect(detect("#abcde")).toBeNull();
    });
  });

  describe("JSON detection", () => {
    it("detects object", () => {
      const d = detect('{"a":1,"b":[2,3]}')!;
      expect(d.kind).toBe("json");
    });

    it("detects array", () => {
      expect(detect("[1,2,3]")!.kind).toBe("json");
    });

    it("rejects malformed JSON", () => {
      expect(detect("{a:1}")).toBeNull();
    });

    it("Pretty action emits multi-line", () => {
      const d = detect('{"a":1}')!;
      const pretty = d.actions.find((a) => a.label === "Pretty")!;
      const out = pretty.transform("");
      expect(out).toContain("\n");
      expect(out).toContain('  "a": 1');
    });

    it("Minify action removes whitespace", () => {
      const d = detect('{ "a" : 1 , "b" : 2 }')!;
      const min = d.actions.find((a) => a.label === "Minify")!;
      expect(min.transform("")).toBe('{"a":1,"b":2}');
    });

    it("skips JSON parse for very large input", () => {
      const big = "[" + "1,".repeat(300_000) + "1]";
      // Either rejected (too big) or detected — but should not throw. The
      // 500_000 cap means a 600k+ char string is bypassed.
      expect(() => detect(big)).not.toThrow();
    });
  });

  describe("Code detection", () => {
    it("detects fenced code block", () => {
      const d = detect("```\nconst x = 1;\nconst y = 2;\n```")!;
      expect(d.kind).toBe("code");
    });

    it("detects multi-line semicolon-style code", () => {
      const code = "const x = 1;\nconst y = 2;\nfunction foo() { return x; }";
      expect(detect(code)!.kind).toBe("code");
    });

    it("detects indented code", () => {
      const code = "function foo() {\n    return 1;\n    return 2;\n}";
      expect(detect(code)!.kind).toBe("code");
    });

    it("does not detect single-line as code", () => {
      expect(detect("const x = 1;")).toBeNull();
    });

    it("Plain unwraps fenced code", () => {
      const d = detect("```js\nconst x=1;\n```")!;
      expect(d.actions[0].transform("")).toBe("const x=1;");
    });

    it("```fenced``` action wraps in triple backticks", () => {
      const d = detect("const x = 1;\nconst y = 2;\nconst z = 3;")!;
      const fenced = d.actions.find((a) => a.label === "```fenced```")!;
      const out = fenced.transform("");
      expect(out.startsWith("```\n")).toBe(true);
      expect(out.endsWith("\n```")).toBe(true);
    });

    it("Indent 4sp prefixes each line with 4 spaces", () => {
      const d = detect("const x = 1;\nconst y = 2;\nconst z = 3;")!;
      const indent = d.actions.find((a) => a.label === "Indent 4sp")!;
      const lines = indent.transform("").split("\n");
      expect(lines.every((l: string) => l.startsWith("    "))).toBe(true);
    });
  });

  describe("Detection priority", () => {
    it("hex wins over plain text", () => {
      expect(detect("#abcdef")!.kind).toBe("color");
    });

    it("URL wins over generic text", () => {
      expect(detect("https://example.com")!.kind).toBe("url");
    });

    it("URL is preferred over email-shaped string when scheme present", () => {
      // mailto: doesn't match URL_RE, http does
      expect(detect("https://a@b.com")!.kind).toBe("url");
    });
  });
});
