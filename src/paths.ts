import { homedir } from "node:os";
import { join } from "node:path";

export const ORIGIN = "https://my.msd.govt.nz";
/** DES, the jobs site MyMSD hands job search, matches and applications to ("MyMSD new"). */
export const DES_ORIGIN = "https://new.my.msd.govt.nz";
/** Hosts whose cookies the session keeps: both sites, MSD's Azure B2C IdP, and RealMe (also B2C). */
export const DOMAINS = ["my.msd.govt.nz", "new.my.msd.govt.nz", "identity.msd.govt.nz", "login.realme.govt.nz"];
export const STORE_DIR = process.env.MYMSD_DIR ?? join(homedir(), ".mymsd-mcp");
export const SESSION_FILE = join(STORE_DIR, "session.json");
export const PROFILE_DIR = join(STORE_DIR, "profile");
/** The stored client-number + date-of-birth + PIN sign-in (mymsd-logon set), mode 600. */
export const CREDENTIALS_FILE = join(STORE_DIR, "credentials.json");
