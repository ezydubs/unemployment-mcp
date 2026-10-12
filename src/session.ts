import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { browserAvailable, harvestCookies } from "./browser.js";
import { DesSession, type DesStored } from "./des-session.js";
import { BotDefenceError, Http, NotLoggedInError, NotPermittedError, SsoDeadError } from "./http.js";
import { CookieJar, type Cookie } from "./jar.js";
import { DOMAINS, SESSION_FILE, STORE_DIR } from "./paths.js";
import { repairSso } from "./sso.js";

const MEMO_MS = 60_000;

export interface SessionInfo {
  isAuthenticated: boolean;
  csrfToken: string | null;
  firstName: string;
  clientNumber: string;
  lastLogin: string | null;
  timeout: number;
  preferredLoginMethod: string;
  verifiedDevice: boolean;
  desUrl: string;
  desBaseParams: string;
  myAccountBaseUrl: string;
  myAccountBaseParameters: string;
  versionNumber: string;
  serverDateTime: string | null;
}

interface Stored {
  cookies: Cookie[];
  info: SessionInfo | null;
  checkedAt: number;
  importedAt: number | null;
  des?: DesStored;
}

const NEXT_STEP = "Sign in again: mymsd_auth login, or sign in at my.msd.govt.nz in Chrome and run mymsd_auth import_chrome.";

/** The signed-in state: a cookie jar, what GET /rest/session last said, and the repair logic around it. */
export class Session {
  readonly jar: CookieJar;
  readonly http: Http;
  /** the DES (jobs site) half, on the same jar */
  readonly des: DesSession;
  info: SessionInfo | null;
  checkedAt: number;
  importedAt: number | null;
  /** how many repairs (SSO replays or challenge refreshes) this process has done */
  repairs = 0;
  private inflight: Promise<SessionInfo> | null = null;

  constructor(stored?: Stored) {
    this.jar = CookieJar.fromJSON(stored?.cookies ?? []);
    this.info = stored?.info ?? null;
    this.checkedAt = stored?.checkedAt ?? 0;
    this.importedAt = stored?.importedAt ?? null;
    this.http = new Http(this.jar, () => this.save());
    this.http.csrfToken = this.info?.csrfToken ?? null;
    this.des = new DesSession(this.jar, () => this.save(), stored?.des);
  }

  static load(): Session {
    try {
      return new Session(JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Stored);
    } catch {
      return new Session();
    }
  }

  save(): void {
    mkdirSync(STORE_DIR, { recursive: true });
    const stored: Stored = { cookies: this.jar.toJSON(), info: this.info, checkedAt: this.checkedAt, importedAt: this.importedAt, des: this.des.toJSON() };
    writeFileSync(SESSION_FILE, JSON.stringify(stored, null, 2));
    chmodSync(SESSION_FILE, 0o600);
  }

  forget(): void {
    rmSync(SESSION_FILE, { force: true });
    this.jar.remove(() => true);
    this.info = null;
    this.checkedAt = 0;
    this.importedAt = null;
    this.http.csrfToken = null;
    this.des.info = null;
    this.des.checkedAt = 0;
  }

  addCookies(cookies: Cookie[]): void {
    this.jar.add(cookies);
    this.importedAt = Date.now();
    this.checkedAt = 0;
    this.save();
  }

  /** GET /rest/session and record what it says (the csrf token for later POSTs, who is signed in). */
  async check(): Promise<SessionInfo> {
    const s = (await this.http.get("/rest/session")) ?? {};
    this.info = {
      isAuthenticated: !!s.isAuthenticated,
      csrfToken: s.csrfToken ?? null,
      firstName: s.firstName ?? "",
      clientNumber: s.clientNumber ?? "",
      lastLogin: s.lastLogin ?? null,
      timeout: Number(s.timeout ?? 0),
      preferredLoginMethod: s.preferredLoginMethod ?? "",
      verifiedDevice: !!s.verifiedDevice,
      desUrl: s.desUrl ?? "",
      desBaseParams: s.desBaseParams ?? "",
      myAccountBaseUrl: s.myAccountBaseUrl ?? "",
      myAccountBaseParameters: s.myAccountBaseParameters ?? "",
      versionNumber: s.versionNumber ?? "",
      serverDateTime: s.serverDateTime ?? null,
    };
    this.http.csrfToken = this.info.csrfToken;
    this.checkedAt = this.info.isAuthenticated ? Date.now() : 0;
    this.save();
    return this.info;
  }

  /** A signed-in session, repaired when needed; memoised for 60 s after a good check; concurrent callers share one repair. */
  async ensure(force = false): Promise<SessionInfo> {
    if (!force && this.info?.isAuthenticated && Date.now() - this.checkedAt < MEMO_MS) return this.info;
    if (!this.inflight) {
      this.inflight = this.establish().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async establish(): Promise<SessionInfo> {
    if (!this.jar.has("my.msd.govt.nz")) {
      throw new NotLoggedInError("No MyMSD session. Run mymsd_auth import_chrome (while signed in to my.msd.govt.nz in Chrome) or mymsd_auth login.");
    }
    let info: SessionInfo | null;
    try {
      info = await this.checkOrChallenge();
    } catch (e) {
      // a redirect or 401 from /rest/session itself just means "no session": repair it like an isAuthenticated: false
      if (!(e instanceof NotLoggedInError)) throw e;
      info = null;
    }
    if (info?.isAuthenticated) return info;
    try {
      await repairSso(this.http);
    } catch (e) {
      if (e instanceof BotDefenceError) {
        await this.repairChallenge();
        await repairSso(this.http);
      } else if (e instanceof SsoDeadError) {
        throw new NotLoggedInError(`MyMSD session has ended and silent sign-in failed (${e.message}). ${NEXT_STEP}`);
      } else throw e;
    }
    this.repairs++;
    info = await this.checkOrChallenge();
    if (!info.isAuthenticated) throw new NotLoggedInError(`MyMSD still reports no session after single sign-on. ${NEXT_STEP}`);
    return info;
  }

  private async checkOrChallenge(): Promise<SessionInfo> {
    try {
      return await this.check();
    } catch (e) {
      if (!(e instanceof BotDefenceError)) throw e;
      await this.repairChallenge();
      return this.check();
    }
  }

  /** Fresh F5 token cookies from a headless browser, when one is installed. */
  async repairChallenge(): Promise<void> {
    if (!(await browserAvailable())) {
      throw new BotDefenceError(
        "MyMSD's bot defence rejected the saved cookies and no browser is installed to refresh them. Open my.msd.govt.nz in Chrome, then run mymsd_auth import_chrome (or install the optional browser: npm i cloakbrowser playwright-core).",
      );
    }
    this.addCookies(await harvestCookies({ jar: this.jar, headless: true, waitForAuth: false, timeoutMs: 30_000 }));
    this.repairs++;
  }

  /** Runs `fn` against a live session; when the call itself reveals the session died, repairs once and retries once. */
  async run<T>(fn: (http: Http) => Promise<T>): Promise<T> {
    await this.ensure();
    const before = this.repairs; // captured before the call: a repair another caller finishes meanwhile also counts
    try {
      return await fn(this.http);
    } catch (e) {
      if (!(e instanceof NotLoggedInError || e instanceof BotDefenceError || e instanceof NotPermittedError)) throw e;
      this.checkedAt = 0;
      await this.ensure(true);
      if (this.repairs === before) throw e; // the session was fine: the error is genuine
      return fn(this.http);
    }
  }

  status() {
    return {
      signedIn: !!this.info?.isAuthenticated,
      firstName: this.info?.firstName ?? null,
      clientNumber: this.info?.clientNumber ?? null,
      lastLogin: this.info?.lastLogin ?? null,
      preferredLoginMethod: this.info?.preferredLoginMethod ?? null,
      verifiedDevice: this.info?.verifiedDevice ?? null,
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      importedAt: this.importedAt ? new Date(this.importedAt).toISOString() : null,
      repairsThisProcess: this.repairs,
      cookies: DOMAINS.map((domain) => ({ domain, names: this.jar.names(domain) })),
      sessionFile: SESSION_FILE,
    };
  }
}
