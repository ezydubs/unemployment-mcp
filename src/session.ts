import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { browserAvailable, harvestCookies } from "./browser.js";
import { loadPinCredentials, type PinCredentials } from "./credentials.js";
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

/** A device-verification code MyMSD sent after a PIN sign-in, waiting for the code to come back. */
export interface PendingVerification {
  token: string;
  sentTo: string;
  at: number;
}

interface Stored {
  cookies: Cookie[];
  info: SessionInfo | null;
  checkedAt: number;
  importedAt: number | null;
  des?: DesStored;
  pendingVerification?: PendingVerification | null;
}

export type PinLoginResult = { signedIn: true; info: SessionInfo } | { signedIn: false; sentTo: string; clientDetails: unknown };

const NEXT_STEP =
  "Sign in again: mymsd_auth login, or sign in at my.msd.govt.nz in Chrome and run mymsd_auth import_chrome; or store your PIN sign-in once (mymsd-logon set <client number> <YYYY-MM-DD> <pin>) and the server signs in by itself from then on.";
const VERIFY_STEP = "run mymsd-logon verify <code> (or mymsd_auth login_pin with code) to finish";
const CHECK_PIN = "Check the client number, date of birth and PIN stored with mymsd-logon (mymsd-logon status).";

/** The signed-in state: a cookie jar, what GET /rest/session last said, and the repair logic around it. */
export class Session {
  readonly jar: CookieJar;
  readonly http: Http;
  /** the DES (jobs site) half, on the same jar */
  readonly des: DesSession;
  info: SessionInfo | null;
  checkedAt: number;
  importedAt: number | null;
  pendingVerification: PendingVerification | null;
  /** how many repairs (SSO replays, PIN sign-ins or challenge refreshes) this process has done */
  repairs = 0;
  private inflight: Promise<SessionInfo> | null = null;
  /** mtime of the session file as this process last wrote or read it; a newer file was written by another process */
  private fileMtime = 0;

  constructor(stored?: Stored) {
    this.jar = CookieJar.fromJSON(stored?.cookies ?? []);
    this.info = stored?.info ?? null;
    this.checkedAt = stored?.checkedAt ?? 0;
    this.importedAt = stored?.importedAt ?? null;
    this.pendingVerification = stored?.pendingVerification ?? null;
    this.http = new Http(this.jar, () => this.save());
    this.http.csrfToken = this.info?.csrfToken ?? null;
    this.des = new DesSession(this.jar, () => this.save(), stored?.des);
  }

  static load(): Session {
    try {
      const s = new Session(JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Stored);
      s.fileMtime = statSync(SESSION_FILE).mtimeMs;
      return s;
    } catch {
      return new Session();
    }
  }

  save(): void {
    mkdirSync(STORE_DIR, { recursive: true });
    const stored: Stored = {
      cookies: this.jar.toJSON(),
      info: this.info,
      checkedAt: this.checkedAt,
      importedAt: this.importedAt,
      des: this.des.toJSON(),
      pendingVerification: this.pendingVerification,
    };
    writeFileSync(SESSION_FILE, JSON.stringify(stored, null, 2));
    chmodSync(SESSION_FILE, 0o600);
    this.fileMtime = statSync(SESSION_FILE).mtimeMs;
  }

  /** Another process (mymsd-logon, a second server) signed in and wrote the file since we last touched it: take its state over ours. */
  reloadIfChanged(): boolean {
    let mtime: number;
    let stored: Stored;
    try {
      mtime = statSync(SESSION_FILE).mtimeMs;
      if (mtime <= this.fileMtime) return false;
      stored = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as Stored;
    } catch {
      return false;
    }
    this.jar.remove(() => true);
    this.jar.add(stored.cookies ?? []);
    this.info = stored.info ?? null;
    this.checkedAt = stored.checkedAt ?? 0;
    this.importedAt = stored.importedAt ?? null;
    this.pendingVerification = stored.pendingVerification ?? null;
    this.http.csrfToken = this.info?.csrfToken ?? null;
    this.des.info = stored.des?.info ?? null;
    this.des.checkedAt = stored.des?.checkedAt ?? 0;
    this.fileMtime = mtime;
    return true;
  }

  forget(): void {
    rmSync(SESSION_FILE, { force: true });
    this.jar.remove(() => true);
    this.info = null;
    this.checkedAt = 0;
    this.importedAt = null;
    this.pendingVerification = null;
    this.fileMtime = 0;
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
    this.reloadIfChanged();
    const pin = loadPinCredentials();
    if (!this.jar.has("my.msd.govt.nz")) {
      if (pin) return this.pinFallback(pin.creds);
      throw new NotLoggedInError(
        "No MyMSD session. Run mymsd_auth import_chrome (while signed in to my.msd.govt.nz in Chrome) or mymsd_auth login; or store your PIN sign-in once with mymsd-logon set and the server signs in by itself.",
      );
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
        if (pin) return this.pinFallback(pin.creds);
        throw new NotLoggedInError(`MyMSD session has ended and silent sign-in failed (${e.message}). ${NEXT_STEP}`);
      } else throw e;
    }
    this.repairs++;
    info = await this.checkOrChallenge();
    if (!info.isAuthenticated) throw new NotLoggedInError(`MyMSD still reports no session after single sign-on. ${NEXT_STEP}`);
    return info;
  }

  /** Single sign-on is gone (or there never was a session): sign in with the stored PIN; a device check is the one thing that still needs a person. */
  private async pinFallback(creds: PinCredentials): Promise<SessionInfo> {
    const r = await this.loginWithPin(creds);
    if (r.signedIn) return r.info;
    throw new NotLoggedInError(`Signed in with your stored PIN, but MyMSD wants to verify this device first: a code was sent to your ${r.sentTo}; ${VERIFY_STEP}.`);
  }

  /**
   * MyMSD's client-number + PIN sign-in, the way its /login page does it: clear any half session, post the details, read
   * the session back. Signed in with a verified device → done. Otherwise MyMSD wants a device-verification code: it is
   * sent (to verifyUsing, or MyMSD's choice) and the token kept in the session file for verifyDevice.
   */
  async loginWithPin(creds: PinCredentials, opts: { rememberMe?: boolean } = {}): Promise<PinLoginResult> {
    const rememberMe = opts.rememberMe ?? true;
    await this.http.post("/rest/session/clear").catch(() => {});
    let answer: any;
    try {
      answer = await this.http.post("/session/login/pin", { clientNumber: creds.clientNumber, dateOfBirth: creds.dateOfBirth, pin: creds.pin, rememberMe: String(rememberMe) });
    } catch (e) {
      if (e instanceof BotDefenceError) throw e;
      const why = (e as Error).message.replace(/^MyMSD session has ended \((.*)\)$/, "$1");
      throw new NotLoggedInError(`MyMSD rejected the PIN sign-in (${why}). ${CHECK_PIN}`);
    }
    const info = await this.checkOrChallenge();
    if (info.isAuthenticated && info.verifiedDevice) {
      this.pendingVerification = null;
      this.repairs++;
      this.save();
      return { signedIn: true, info };
    }
    const wantsVerification = (typeof answer?.redirectUrl === "string" && /verif/i.test(answer.redirectUrl)) || (info.isAuthenticated && !info.verifiedDevice);
    if (!wantsVerification) {
      throw new NotLoggedInError(`MyMSD rejected the PIN sign-in (no session after signing in; MyMSD answered ${JSON.stringify(answer ?? null).slice(0, 200)}). ${CHECK_PIN}`);
    }
    const sent = await this.http.post("/rest/logon/verifydevice/send-code", { verifyUsing: creds.verifyUsing ?? "", token: "", rememberDevice: rememberMe });
    const sentTo = String(sent?.verificationSentTo ?? "phone or email");
    this.pendingVerification = { token: String(sent?.token ?? ""), sentTo, at: Date.now() };
    this.save();
    return { signedIn: false, sentTo, clientDetails: sent?.clientDetails ?? null };
  }

  /** The 6-digit code MyMSD sent to verify this device, finishing a PIN sign-in. */
  async verifyDevice(code: string, rememberDevice = true): Promise<SessionInfo> {
    const pending = this.pendingVerification;
    if (!pending?.token) throw new NotLoggedInError("no verification code is pending: sign in with the PIN first (mymsd-logon login, or mymsd_auth login_pin)");
    await this.http.post("/rest/logon/verifydevice/verify-code", { code, token: pending.token, rememberDevice });
    this.pendingVerification = null;
    const info = await this.checkOrChallenge();
    if (!info.isAuthenticated) {
      this.save();
      throw new NotLoggedInError("MyMSD still reports no session after the device verification: sign in with the PIN again");
    }
    this.repairs++;
    this.save();
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
    let pinCredentials: string;
    try {
      pinCredentials = loadPinCredentials()?.source ?? "none";
    } catch {
      pinCredentials = "unusable";
    }
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
      /** where the PIN sign-in comes from (env, file, none, unusable); never the values */
      pinCredentials,
      /** where a device-verification code was sent, when one is waiting */
      pendingVerification: this.pendingVerification?.sentTo ?? null,
      cookies: DOMAINS.map((domain) => ({ domain, names: this.jar.names(domain) })),
      sessionFile: SESSION_FILE,
    };
  }
}
