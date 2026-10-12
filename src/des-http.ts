import { randomUUID } from "node:crypto";
import https from "node:https";
import { NotLoggedInError, USER_AGENT } from "./http.js";
import type { CookieJar } from "./jar.js";
import { DES_ORIGIN } from "./paths.js";

/** DES answered with its envelope's error, or an HTTP status it does not explain. */
export class DesError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public data: unknown = null,
  ) {
    super(message);
  }
}

export interface NavResponse {
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
}
/** A navigation-style request: GET, or POST of a urlencoded form when `form` is given. */
export type Navigate = (url: string, headers: Record<string, string>, form?: string) => Promise<NavResponse>;

/** node:https, because fetch() always adds `Sec-Fetch-Mode: cors` and DES's sign-in servlets refuse that with 403. */
export const httpsNavigate: Navigate = (url, headers, form) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const h: Record<string, string> = { ...headers };
    if (form !== undefined) {
      h["content-type"] = "application/x-www-form-urlencoded";
      h["content-length"] = String(Buffer.byteLength(form));
    }
    const req = https.request({ host: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: form === undefined ? "GET" : "POST", headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (k !== "set-cookie" && v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: out, setCookie: res.headers["set-cookie"] ?? [], body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    if (form !== undefined) req.write(form);
    req.end();
  });

const NAV_HEADERS = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-NZ,en;q=0.9", "upgrade-insecure-requests": "1" };
type Params = Record<string, string | number | boolean | null | undefined>;

export class DesHttp {
  constructor(
    private readonly jar: CookieJar,
    private readonly onCookies: () => void = () => {},
    private readonly navigate: Navigate = httpsNavigate,
  ) {}

  /** The `__Host-csrf` cookie the SPA reads and passes as `?csrf=` on apply and renew. */
  csrfToken(): string | null {
    return this.jar.toJSON().find((c) => c.domain === "new.my.msd.govt.nz" && c.name === "__Host-csrf" && c.value !== "")?.value ?? null;
  }

  private store(url: string, set: string[]): void {
    if (set.length && this.jar.store(url, set)) this.onCookies();
  }

  private headers(extra: Record<string, string>, url: string): Record<string, string> {
    const h: Record<string, string> = { "user-agent": USER_AGENT, ...extra };
    const cookie = this.jar.header(url);
    if (cookie) h.cookie = cookie;
    return h;
  }

  /** A JSON API call like the SPA's: GET, or POST when a body is given; same-origin Referer because Sling's referrer filter wants it. */
  async api(path: string, body?: unknown, params: Params = {}): Promise<any> {
    const u = new URL(path, DES_ORIGIN);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    const url = u.toString();
    const headers = this.headers({ accept: "application/json", "content-type": "application/json", "x-transaction-id": randomUUID(), origin: DES_ORIGIN, referer: `${DES_ORIGIN}/en/jobs/` }, url);
    const res = await fetch(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.store(url, res.headers.getSetCookie());
    return this.parse(res);
  }

  /** Mirrors the SPA's response handling: 200 + JSON → the envelope; 401 or a redirect → no session; anything else → DesError with the site's message. */
  async parse(res: Response): Promise<any> {
    if (res.status >= 300 && res.status < 400) throw new NotLoggedInError(`DES redirected to ${res.headers.get("location") ?? "another page"}: no session`);
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let json: any = null;
    if (type.includes("json") && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.status === 200 && json !== null) return json;
    if (res.status === 401) throw new NotLoggedInError("DES session has ended or was never started");
    const detail = json?.message ?? json?.error?.detail ?? (typeof json?.error === "string" ? json.error : null);
    const message = typeof detail === "string" && detail ? detail : text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || `HTTP ${res.status}`;
    const code = json?.status ?? json?.statusCode;
    throw new DesError(code ? String(code) : `http_${res.status}`, message, res.status, json?.error ?? null);
  }

  /** A top-level navigation with the jar's cookies; redirects are left to the caller. */
  async nav(url: string, form?: string): Promise<NavResponse & { location: string | null }> {
    const r = await this.navigate(url, this.headers(NAV_HEADERS, url), form);
    this.store(url, r.setCookie);
    return { ...r, location: r.headers.location ?? null };
  }

  /** A binary download (the CV): the bytes, their type and the name the site suggests. */
  async fetchFile(path: string): Promise<{ bytes: Buffer; contentType: string; filename: string | null }> {
    const url = new URL(path, DES_ORIGIN).toString();
    const res = await fetch(url, { headers: this.headers({ accept: "*/*", referer: `${DES_ORIGIN}/en/jobs/` }, url), redirect: "manual" });
    this.store(url, res.headers.getSetCookie());
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || contentType.includes("text/html") || contentType.includes("json")) {
      if (!res.ok || contentType.includes("json")) await this.parse(res); // a 401, a redirect or an envelope error say why
      throw new DesError("download_failed", `expected a file, got ${contentType || `HTTP ${res.status}`}`, res.status);
    }
    const raw = res.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? null;
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType, filename: raw ? decodeURIComponent(raw) : null };
  }
}
