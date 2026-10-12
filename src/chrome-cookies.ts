import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { domainMatches, type Cookie } from "./jar.js";

/**
 * Chrome's cookie store, read straight from its SQLite file. Chrome keeps the file locked while it runs, so it is
 * copied first. Values are "v10" + AES-128-CBC (key = PBKDF2-SHA1 of the Keychain "Chrome Safe Storage" password,
 * salt "saltysalt", 1003 rounds; IV = 16 spaces); since DB meta version 24 (Chrome 130+) the plaintext starts with
 * SHA-256(host_key), which is stripped.
 */
export function chromeCookiesPath(profile = process.env.CHROME_PROFILE ?? "Default"): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "User Data")
        : join(homedir(), ".config", "google-chrome");
  return join(base, profile, "Cookies");
}

/** The Keychain password Chrome encrypts cookies with (macOS shows one "node wants to use your confidential information" prompt). */
export async function keychainPassword(): Promise<string> {
  const { stdout } = await promisify(execFile)("security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage"]);
  return stdout.trim();
}

export const deriveKey = (password: string): Buffer => pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");

export function decryptValue(encrypted: Buffer, key: Buffer, stripHostHash: boolean): string {
  if (encrypted.length === 0) return "";
  if (encrypted.subarray(0, 3).toString("latin1") !== "v10") return encrypted.toString("utf8");
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([d.update(encrypted.subarray(3)), d.final()]);
  return (stripHostHash ? plain.subarray(32) : plain).toString("utf8");
}

/** Chrome stores expiry as microseconds since 1601-01-01; 0 means a session cookie. */
export const chromeTimeToEpoch = (expiresUtc: number): number =>
  expiresUtc > 0 ? Math.floor(expiresUtc / 1_000_000 - 11_644_473_600) : -1;

export interface ReadChromeOptions {
  profile?: string;
  /** hosts whose cookies to keep (domain cookies covering them included) */
  domains: string[];
  cookiesPath?: string;
  password?: string;
}

interface Row {
  host_key: string;
  name: string;
  path: string;
  value: string;
  encrypted_value: Uint8Array | null;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
}

export async function readChromeCookies(opts: ReadChromeOptions): Promise<Cookie[]> {
  const src = opts.cookiesPath ?? chromeCookiesPath(opts.profile);
  const dir = mkdtempSync(join(tmpdir(), "mymsd-chrome-"));
  const copy = join(dir, "Cookies");
  try {
    copyFileSync(src, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const meta = db.prepare("select value from meta where key = 'version'").get() as { value?: string } | undefined;
      const version = Number(meta?.value ?? 0);
      const key = deriveKey(opts.password ?? (await keychainPassword()));
      // expires_utc (µs since 1601) is above 2^53, which node:sqlite refuses to hand over as a number
      const stmt = db.prepare("select host_key, name, path, value, encrypted_value, expires_utc, is_secure, is_httponly from cookies");
      stmt.setReadBigInts(true);
      const rows = stmt.all() as unknown as Row[];
      const out: Cookie[] = [];
      for (const r of rows) {
        if (!opts.domains.some((h) => domainMatches(h, r.host_key))) continue;
        const enc = r.encrypted_value ? Buffer.from(r.encrypted_value) : Buffer.alloc(0);
        const value = enc.length ? decryptValue(enc, key, version >= 24) : String(r.value ?? "");
        out.push({
          name: r.name,
          value,
          domain: r.host_key,
          path: r.path || "/",
          expires: chromeTimeToEpoch(Number(r.expires_utc)),
          secure: !!r.is_secure,
          httpOnly: !!r.is_httponly,
        });
      }
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
