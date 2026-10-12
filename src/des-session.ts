import { DesHttp, type Navigate } from "./des-http.js";
import { repairDes } from "./des-oauth.js";
import { NotLoggedInError, SsoDeadError } from "./http.js";
import type { Cookie, CookieJar } from "./jar.js";

const MEMO_MS = 60_000;
const DES_HOST = "new.my.msd.govt.nz";
export const DES_NEXT_STEP = "Sign in to DES: des_auth login, or sign in at new.my.msd.govt.nz in Chrome and run des_auth import_chrome.";

export interface DesInfo {
  authenticated: boolean;
  reason: string | null;
  remaining: number;
  renew: boolean;
  clientNumber: string;
  firstName: string;
  lastName: string;
  profileCompleteness: string;
  profileStatus: string;
  migratedUser: string;
}
export interface DesStored {
  info: DesInfo | null;
  checkedAt: number;
}

/** The DES half of the signed-in state: shares the jar with the MyMSD session, has its own check and repair. */
export class DesSession {
  readonly http: DesHttp;
  info: DesInfo | null;
  checkedAt: number;
  /** how many silent sign-ins this process has replayed */
  repairs = 0;
  private inflight: Promise<DesInfo> | null = null;

  constructor(
    readonly jar: CookieJar,
    private readonly save: () => void,
    stored?: DesStored,
    navigate?: Navigate,
  ) {
    this.http = new DesHttp(jar, save, navigate);
    this.info = stored?.info ?? null;
    this.checkedAt = stored?.checkedAt ?? 0;
  }

  toJSON(): DesStored {
    return { info: this.info, checkedAt: this.checkedAt };
  }

  /** a DES session cookie with a value (a logout leaves the names behind, empty) */
  hasCookies(): boolean {
    return this.jar.toJSON().some((c) => c.domain === DES_HOST && c.name.startsWith("__Host-") && c.value !== "");
  }

  /** B2C's SSO cookie, the one thing a silent sign-in needs */
  hasSso(): boolean {
    return this.jar.toJSON().some((c) => c.name.startsWith("x-ms-cpim-sso") && /identity\.msd\.govt\.nz$/.test(c.domain) && c.value !== "");
  }

  addCookies(cookies: Cookie[]): void {
    this.jar.add(cookies.filter((c) => c.value !== ""));
    this.checkedAt = 0;
    this.save();
  }

  forget(): void {
    this.jar.remove((c) => c.domain === DES_HOST);
    this.info = null;
    this.checkedAt = 0;
    this.save();
  }

  /** POST /bin/auth/check, the SPA's own probe: who is signed in and for how many more seconds. */
  async check(): Promise<DesInfo> {
    const s = (await this.http.api("/bin/auth/check", { type: "userInfo" })) ?? {};
    this.info = {
      authenticated: !!s.authenticated,
      reason: s.reason ?? null,
      remaining: Number(s.remaining ?? 0),
      renew: !!s.renew,
      clientNumber: s.clientNumber ?? "",
      firstName: s.firstName ?? "",
      lastName: s.lastName ?? "",
      profileCompleteness: s.profileCompleteness ?? "",
      profileStatus: s.profileStatus ?? "",
      migratedUser: s.migratedUser ?? "",
    };
    this.checkedAt = this.info.authenticated ? Date.now() : 0;
    this.save();
    return this.info;
  }

  /** A live DES session: a good check is trusted for 60 s and never past what `remaining` promised; concurrent callers share one repair. */
  async ensure(force = false): Promise<DesInfo> {
    const age = Date.now() - this.checkedAt;
    if (!force && this.info?.authenticated && age < MEMO_MS && age < (this.info.remaining - 30) * 1000) return this.info;
    if (!this.inflight) {
      this.inflight = this.establish().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async establish(): Promise<DesInfo> {
    let info: DesInfo | null = null;
    if (this.hasCookies()) {
      try {
        info = await this.check();
      } catch (e) {
        // a 401 or redirect from the check itself just means "no session": repair it like an authenticated: false
        if (!(e instanceof NotLoggedInError)) throw e;
      }
    }
    if (info?.authenticated) return info;
    if (!this.hasSso()) throw new NotLoggedInError(`No DES session. ${DES_NEXT_STEP}`);
    try {
      await repairDes(this.http);
    } catch (e) {
      if (e instanceof SsoDeadError) throw new NotLoggedInError(`DES session has ended and silent sign-in failed (${e.message}). ${DES_NEXT_STEP}`);
      throw e;
    }
    this.repairs++;
    info = await this.check();
    if (!info.authenticated) throw new NotLoggedInError(`DES still reports no session after single sign-on (${info.reason ?? "unknown reason"}). ${DES_NEXT_STEP}`);
    return info;
  }

  /** Runs `fn` against a live session; when the call reveals the session died, repairs once and retries once. */
  async run<T>(fn: (http: DesHttp) => Promise<T>): Promise<T> {
    await this.ensure();
    const before = this.repairs; // captured before the call: a repair another caller finishes meanwhile also counts
    try {
      return await fn(this.http);
    } catch (e) {
      if (!(e instanceof NotLoggedInError)) throw e;
      this.checkedAt = 0;
      await this.ensure(true);
      if (this.repairs === before) throw e; // the session was fine: the error is genuine
      return fn(this.http);
    }
  }

  status() {
    const left = this.info?.authenticated ? Math.max(0, Math.round(this.info.remaining - (Date.now() - this.checkedAt) / 1000)) : 0;
    return {
      signedIn: !!this.info?.authenticated,
      firstName: this.info?.firstName ?? null,
      clientNumber: this.info?.clientNumber ?? null,
      profileCompleteness: this.info?.profileCompleteness ?? null,
      profileStatus: this.info?.profileStatus ?? null,
      remainingSeconds: left,
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      repairsThisProcess: this.repairs,
      cookies: this.jar.toJSON().filter((c) => c.domain === DES_HOST).map((c) => c.name), // DES's own host-only cookies, not .msd.govt.nz analytics
      ssoCookie: this.hasSso(),
    };
  }
}
