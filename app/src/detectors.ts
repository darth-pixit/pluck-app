// Content detectors for smart paste. Each detector inspects a clipboard item
// and, if it matches, returns a label plus a list of paste-format variants the
// user can pick from. The first action is always the "plain" form.

export interface PasteAction {
  label: string;
  transform: (s: string) => string;
}

export interface Detection {
  kind: string;
  badge: string;
  actions: PasteAction[];
}

const URL_RE   = /^(https?:\/\/|ftp:\/\/)\S+$/i;
const WWW_RE   = /^www\.[^\s.]+\.\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_RE   = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function rgbToHsl(r: number, g: number, b: number): string {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2;                 break;
      case bn: h = (rn - gn) / d + 4;                 break;
    }
    h /= 6;
  }
  return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

function detectHex(trimmed: string): Detection | null {
  if (!HEX_RE.test(trimmed)) return null;
  const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  // Expand 3/4-digit shorthand to 6/8.
  const full =
    raw.length === 3 ? raw.split("").map(c => c + c).join("") :
    raw.length === 4 ? raw.split("").map(c => c + c).join("") :
    raw;
  const six = full.slice(0, 6);
  const r = parseInt(six.slice(0, 2), 16);
  const g = parseInt(six.slice(2, 4), 16);
  const b = parseInt(six.slice(4, 6), 16);
  return {
    kind: "color",
    badge: "Color",
    actions: [
      { label: "Plain",  transform: () => trimmed },
      { label: "#hex",   transform: () => "#" + six.toLowerCase() },
      { label: "rgb()",  transform: () => `rgb(${r}, ${g}, ${b})` },
      { label: "hsl()",  transform: () => rgbToHsl(r, g, b) },
    ],
  };
}

function detectJson(trimmed: string): Detection | null {
  const first = trimmed[0], last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  return {
    kind: "json",
    badge: "JSON",
    actions: [
      { label: "Plain",  transform: () => trimmed },
      { label: "Pretty", transform: () => JSON.stringify(parsed, null, 2) },
      { label: "Minify", transform: () => JSON.stringify(parsed) },
    ],
  };
}

function detectUrl(trimmed: string): Detection | null {
  const isUrl = URL_RE.test(trimmed) || WWW_RE.test(trimmed);
  if (!isUrl) return null;
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let stripped = normalized;
  try {
    const u = new URL(normalized);
    u.search = "";
    u.hash = "";
    stripped = u.toString().replace(/\/$/, "");
  } catch { /* keep as-is */ }
  let host = normalized;
  try { host = new URL(normalized).hostname.replace(/^www\./, ""); } catch { /* */ }
  return {
    kind: "url",
    badge: "URL",
    actions: [
      { label: "Plain",      transform: () => trimmed },
      { label: "Markdown",   transform: () => `[${host}](${normalized})` },
      { label: "HTML <a>",   transform: () => `<a href="${normalized}">${host}</a>` },
      { label: "No params",  transform: () => stripped },
    ],
  };
}

function detectEmail(trimmed: string): Detection | null {
  if (!EMAIL_RE.test(trimmed)) return null;
  return {
    kind: "email",
    badge: "Email",
    actions: [
      { label: "Plain",    transform: () => trimmed },
      { label: "mailto:",  transform: () => `mailto:${trimmed}` },
      { label: "Markdown", transform: () => `[${trimmed}](mailto:${trimmed})` },
    ],
  };
}

function looksLikeCode(content: string): boolean {
  // Already-fenced markdown.
  if (/^```[\s\S]*```$/m.test(content.trim())) return true;
  const lines = content.split("\n");
  if (lines.length < 2) return false;
  // Heuristic: many lines have leading indentation and code-like punctuation.
  const codey = lines.filter(l =>
    /^(\s{2,}|\t)/.test(l) ||
    /[;{}]\s*$/.test(l) ||
    /^\s*(import|from|function|const|let|var|class|def|return|if|for|while|public|private)\b/.test(l)
  ).length;
  return codey / lines.length >= 0.4;
}

function detectCode(content: string): Detection | null {
  if (!looksLikeCode(content)) return null;
  // Strip an existing markdown fence if present, so "Plain" gives clean code.
  const fenced = content.trim().match(/^```(\w*)\n([\s\S]*?)\n```$/);
  const body = fenced ? fenced[2] : content;
  return {
    kind: "code",
    badge: "Code",
    actions: [
      { label: "Plain",        transform: () => body },
      { label: "```fenced```", transform: () => "```\n" + body.replace(/\n+$/, "") + "\n```" },
      { label: "Indent 4sp",   transform: () => body.split("\n").map(l => "    " + l).join("\n") },
    ],
  };
}

export function detect(content: string): Detection | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  return (
    detectHex(trimmed) ||
    detectJson(trimmed) ||
    detectUrl(trimmed) ||
    detectEmail(trimmed) ||
    detectCode(content) ||
    null
  );
}
