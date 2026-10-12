import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { CookieJar } from "./jar.js";
import { ORIGIN } from "./paths.js";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

/** The site's error envelope `{ error: { code, message, data } }`, or an HTTP status it does not explain. */
export class MsdError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public data: unknown = null,
  ) {
    super(message);
  }
}
/** No usable session; the message names the mymsd_auth action that fixes it. */
export class NotLoggedInError extends Error {}
/** F5 bot defence served its JavaScript challenge instead of a response. */
export class BotDefenceError extends Error {}
/** The site answered with its login page (HTTP 403): the feature is not available to this client. */
export class NotPermittedError extends Error {}
/** Silent single-sign-on cannot complete: the identity provider wants a person. */
export class SsoDeadError extends Error {}

export const isChallengePage = (text: string): boolean => /window\["bobcmn"\]|\/TSPD\/[^"']*\?type=/.test(text);

export function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return types[ext] ?? "application/octet-stream";
}

export interface RawInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  redirect?: "follow" | "manual";
}

type Params = Record<string, string | number | boolean | null | undefined>;

export class Http {
  csrfToken: string | null = null;

  constructor(
    private readonly jar: CookieJar,
    private readonly onCookies: () => void = () => {},
  ) {}

  /** fetch with the jar's cookies and our user agent; Set-Cookie merged back into the jar. Never throws on an HTTP status. */
  async raw(url: string, init: RawInit = {}): Promise<Response> {
    const full = new URL(url, ORIGIN).toString();
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json, text/plain, */*", ...(init.headers ?? {}) };
    const cookie = this.jar.header(full);
    if (cookie) headers.cookie = cookie;
    const res = await fetch(full, { method: init.method ?? "GET", headers, body: init.body ?? undefined, redirect: init.redirect ?? "manual" });
    const set = res.headers.getSetCookie();
    if (set.length && this.jar.store(full, set)) this.onCookies();
    return res;
  }

  private xhr(json = true): Record<string, string> {
    const h: Record<string, string> = { "x-requested-with": "XMLHttpRequest", referer: `${ORIGIN}/dashboard` };
    if (json) h["content-type"] = "application/json; charset=utf-8";
    return h;
  }

  async get(path: string, params: Params = {}): Promise<any> {
    const u = new URL(path, ORIGIN);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    return this.parse(await this.raw(u.toString(), { headers: this.xhr() }));
  }

  /** JSON POST; the body gets the session's csrfToken like the site's own ajax util. No body → no body. */
  async post(path: string, body?: Record<string, unknown>): Promise<any> {
    const payload = body ? JSON.stringify({ ...body, csrfToken: this.csrfToken }) : null;
    return this.parse(await this.raw(path, { method: "POST", headers: this.xhr(), body: payload }));
  }

  async delete(path: string): Promise<any> {
    return this.parse(await this.raw(path, { method: "DELETE", headers: this.xhr() }));
  }

  /** Multipart upload exactly like the site: `file` for one file, `file1..fileN` for several, plus `meta-data` JSON (or a bare csrfToken field). */
  async upload(path: string, files: { path: string; name?: string; type?: string }[], metaData?: Record<string, unknown>): Promise<any> {
    const form = new FormData();
    if (metaData) form.append("meta-data", JSON.stringify({ ...metaData, csrfToken: this.csrfToken }));
    else form.append("csrfToken", this.csrfToken ?? "");
    files.forEach((f, i) => {
      const blob = new Blob([readFileSync(f.path)], { type: f.type ?? mimeOf(f.path) });
      form.append(files.length === 1 ? "file" : `file${i + 1}`, blob, f.name ?? basename(f.path));
    });
    return this.parse(await this.raw(path, { method: "POST", headers: this.xhr(false), body: form }));
  }

  /** Saves a binary response (letters, finance PDF) to a file. */
  async download(path: string, toPath: string): Promise<{ path: string; bytes: number; contentType: string }> {
    const res = await this.raw(path, { headers: this.xhr(false) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || type.includes("text/html") || type.includes("json")) {
      await this.parse(res);
      throw new MsdError("download_failed", `expected a file, got ${type || `HTTP ${res.status}`}`, res.status);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(toPath), { recursive: true });
    writeFileSync(toPath, buf);
    return { path: toPath, bytes: buf.length, contentType: type };
  }

  /** Mirrors the site's ajax util: 204 → null; JSON → object; HTML → challenge / not permitted; envelope → MsdError. */
  async parse(res: Response): Promise<any> {
    if (res.status === 204) return null;
    if (res.status >= 300 && res.status < 400) {
      throw new NotLoggedInError(`MyMSD redirected to ${res.headers.get("location") ?? "another page"}: the session has ended`);
    }
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (type.includes("json")) {
      const body = text ? JSON.parse(text) : null;
      if (res.ok) return body;
      const err = (body?.error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
      const code = String(err.code ?? (res.status === 401 ? "unauthenticated" : `http_${res.status}`));
      if (res.status === 401 || code.endsWith("unauthenticated")) throw new NotLoggedInError(`MyMSD session has ended (${code})`);
      throw new MsdError(code, String(err.message ?? `HTTP ${res.status}`), res.status, err.data ?? null);
    }
    if (isChallengePage(text)) throw new BotDefenceError("MyMSD's bot defence (F5) challenged the request: the token cookies are missing or stale");
    if (res.status === 403) throw new NotPermittedError("not available on this account (MyMSD answered with its login page)");
    if (res.status === 401) throw new NotLoggedInError("MyMSD session has ended");
    if (res.ok) return text;
    throw new MsdError(`http_${res.status}`, `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
}
