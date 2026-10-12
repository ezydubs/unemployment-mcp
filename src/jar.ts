export interface Cookie {
  name: string;
  value: string;
  /** host; a leading dot marks a domain cookie (".msd.govt.nz" matches every subdomain) */
  domain: string;
  path: string;
  /** epoch seconds; -1 for a session cookie */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

export function domainMatches(host: string, cookieDomain: string): boolean {
  const h = host.toLowerCase();
  const d = cookieDomain.toLowerCase();
  if (d.startsWith(".")) {
    const bare = d.slice(1);
    return h === bare || h.endsWith(`.${bare}`);
  }
  return h === d;
}

export function pathMatches(path: string, cookiePath: string): boolean {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || path[cookiePath.length] === "/";
}

const now = () => Math.floor(Date.now() / 1000);
const key = (c: Cookie) => `${c.domain}|${c.path}|${c.name}`;

/** RFC 6265 default-path: the request path up to (not including) its last slash. */
function defaultPath(p: string): string {
  if (!p.startsWith("/")) return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** One Set-Cookie line → Cookie (null when malformed). A Domain attribute covering the host makes a domain cookie; none → host-only. */
export function parseSetCookie(line: string, url: URL): Cookie | null {
  const parts = line.split(";").map((p) => p.trim());
  const eq = parts[0].indexOf("=");
  if (eq <= 0) return null;
  const c: Cookie = {
    name: parts[0].slice(0, eq).trim(),
    value: parts[0].slice(eq + 1).trim(),
    domain: url.hostname,
    path: defaultPath(url.pathname),
    expires: -1,
    secure: false,
    httpOnly: false,
  };
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const attr of parts.slice(1)) {
    const [k, ...rest] = attr.split("=");
    const v = rest.join("=").trim();
    switch (k.trim().toLowerCase()) {
      case "domain": {
        const d = v.replace(/^\./, "").toLowerCase();
        if (d && domainMatches(url.hostname, `.${d}`)) c.domain = `.${d}`;
        break;
      }
      case "path":
        if (v.startsWith("/")) c.path = v;
        break;
      case "max-age":
        if (/^-?\d+$/.test(v)) maxAge = Number(v);
        break;
      case "expires": {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
        break;
      }
      case "secure":
        c.secure = true;
        break;
      case "httponly":
        c.httpOnly = true;
        break;
    }
  }
  if (maxAge != null) c.expires = now() + maxAge;
  else if (expires != null) c.expires = expires;
  return c;
}

export class CookieJar {
  private cookies = new Map<string, Cookie>();

  constructor(cookies: Cookie[] = []) {
    this.add(cookies);
  }

  static fromJSON(json: unknown): CookieJar {
    return new CookieJar(Array.isArray(json) ? (json as Cookie[]) : []);
  }

  toJSON(): Cookie[] {
    this.sweep();
    return [...this.cookies.values()];
  }

  get size(): number {
    this.sweep();
    return this.cookies.size;
  }

  /** Adds or replaces cookies (same domain, path and name); an already-expired cookie deletes its predecessor. */
  add(cookies: Cookie[]): void {
    for (const c of cookies) {
      const k = key({ ...c, path: c.path || "/" });
      if (c.expires !== -1 && c.expires <= now()) this.cookies.delete(k);
      else this.cookies.set(k, { ...c, path: c.path || "/" });
    }
  }

  has(host: string): boolean {
    return this.names(host).length > 0;
  }

  names(host: string): string[] {
    this.sweep();
    return [...this.cookies.values()].filter((c) => domainMatches(host, c.domain)).map((c) => c.name);
  }

  remove(pred: (c: Cookie) => boolean): number {
    let n = 0;
    for (const [k, c] of this.cookies) {
      if (pred(c)) {
        this.cookies.delete(k);
        n++;
      }
    }
    return n;
  }

  /** The Cookie request header for a URL: matching, unexpired cookies, longer paths first (RFC 6265 §5.4). */
  header(url: string): string {
    this.sweep();
    const u = new URL(url);
    const https = u.protocol === "https:";
    return [...this.cookies.values()]
      .filter((c) => domainMatches(u.hostname, c.domain) && pathMatches(u.pathname || "/", c.path) && (https || !c.secure))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Stores the Set-Cookie lines of a response to `url`; returns how many were applied (stored or deleted). */
  store(url: string, setCookie: string[]): number {
    const u = new URL(url);
    let n = 0;
    for (const line of setCookie) {
      const c = parseSetCookie(line, u);
      if (c) {
        this.add([c]);
        n++;
      }
    }
    return n;
  }

  private sweep(): void {
    const t = now();
    for (const [k, c] of this.cookies) if (c.expires !== -1 && c.expires <= t) this.cookies.delete(k);
  }
}
