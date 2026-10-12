export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "$1,234.50" / "-$12.00"; the finance page sends amounts already formatted, those pass through; "" for nothing. */
export function nzd(n: unknown): string {
  if (n == null || n === "") return "";
  if (typeof n === "string" && /[^\d.,\s-]/.test(n)) return n;
  const v = Number(String(n).replace(/[,\s]/g, ""));
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? "-" : ""}$${abs}`;
}

/** "Tue 13 Oct 2026" from "2026-10-13" (or "2026-10-13 15:58" → with the time); the site's dates are NZ local, no zone. Other strings pass through. */
export function day(s: unknown): string {
  if (typeof s !== "string") return "";
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const base = `${DAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
  return m[4] ? `${base} ${m[4]}:${m[5]}` : base;
}

/** The tool result shape every tool returns: summary lines first, then the data as JSON. */
export function result(summary: string | string[], data: unknown): ToolResult {
  const head = Array.isArray(summary) ? summary.filter((l) => l !== "").join("\n") : summary;
  return { content: [{ type: "text", text: `${head}\n\n${JSON.stringify(data, null, 2)}` }] };
}
