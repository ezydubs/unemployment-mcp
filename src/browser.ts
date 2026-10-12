import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { domainMatches, type Cookie, type CookieJar } from "./jar.js";
import { DES_ORIGIN, DOMAINS, ORIGIN, PROFILE_DIR } from "./paths.js";

/**
 * The only two things plain HTTP cannot do: run F5's JavaScript challenge to get fresh token cookies, and host a
 * sign-in a person types into. Both use CloakBrowser (stealth Chromium) when the optional package is installed;
 * the specifier is a variable so TypeScript and Node do not require it to exist.
 */
const PACKAGE = "cloakbrowser";

async function load(): Promise<any> {
  try {
    return await import(PACKAGE);
  } catch {
    throw new Error("the optional browser is not installed: run `npm i cloakbrowser playwright-core` in the mymsd-mcp folder, or use mymsd_auth import_chrome");
  }
}

export async function browserAvailable(): Promise<boolean> {
  try {
    await import(PACKAGE);
    return true;
  } catch {
    return false;
  }
}

export const toPlaywrightCookie = (c: Cookie) => ({ ...c, sameSite: "Lax" as const });
export const fromPlaywrightCookie = (c: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean }): Cookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: c.expires > 0 ? Math.floor(c.expires) : -1,
  secure: !!c.secure,
  httpOnly: !!c.httpOnly,
});

export type Site = "mymsd" | "des";
/** Where a sign-in starts: MyMSD's dashboard (it bounces to the login), or DES's login servlet returning to My jobs. */
export const harvestStart = (site: Site = "mymsd"): string => (site === "des" ? `${DES_ORIGIN}/bin/auth/login?rt=${encodeURIComponent("/my-jobs/")}` : `${ORIGIN}/dashboard`);

/** In-page readiness probes (serialised into the page, so no closures): each answers { isAuthenticated } or null. */
const PROBES = {
  mymsd: async () => {
    try {
      const r = await fetch("/rest/session", { headers: { "X-Requested-With": "XMLHttpRequest" } });
      return (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
    } catch {
      return null;
    }
  },
  des: async () => {
    try {
      const r = await fetch("/bin/auth/check", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
      return j ? { isAuthenticated: !!j.authenticated } : null;
    } catch {
      return null;
    }
  },
};

export interface HarvestOptions {
  jar: Pick<CookieJar, "toJSON">;
  headless: boolean;
  /** wait until /rest/session says isAuthenticated (interactive login) instead of just until it answers JSON (challenge solved) */
  waitForAuth: boolean;
  timeoutMs: number;
  /** which site to sign in to; default MyMSD */
  site?: Site;
}

/** Opens the site in CloakBrowser seeded with the jar, waits for the F5 challenge (and optionally a sign-in) to complete, returns every cookie of ours. */
export async function harvestCookies(o: HarvestOptions): Promise<Cookie[]> {
  const { launchPersistentContext } = await load();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await launchPersistentContext({ userDataDir: PROFILE_DIR, headless: o.headless, locale: "en-NZ", timezone: "Pacific/Auckland" });
  try {
    await ctx.addCookies(o.jar.toJSON().map(toPlaywrightCookie));
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(harvestStart(o.site), { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + o.timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      const s = await page.evaluate(PROBES[o.site ?? "mymsd"]).catch(() => null);
      if (s && (!o.waitForAuth || s.isAuthenticated)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) throw new Error(o.waitForAuth ? "no sign-in completed before the timeout" : "the browser did not get past the site's bot-defence challenge");
    const cookies: any[] = await ctx.cookies();
    return cookies.filter((c) => DOMAINS.some((d) => domainMatches(d, c.domain))).map(fromPlaywrightCookie);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Fallback for `login` without the optional browser: open the site in the user's own browser. */
export async function openInChrome(url: string): Promise<void> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  await promisify(execFile)(cmd, args);
}
