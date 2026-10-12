import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CREDENTIALS_FILE, STORE_DIR } from "./paths.js";

export { CREDENTIALS_FILE };

/** What MyMSD's client-number + PIN sign-in takes; verifyUsing picks where a device-verification code goes when MyMSD asks for one. */
export interface PinCredentials {
  clientNumber: string;
  dateOfBirth: string;
  pin: string;
  verifyUsing?: "phone" | "email";
}
export type PinSource = "env" | "file";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function validatePinCredentials(raw: Record<string, unknown>): PinCredentials {
  const clientNumber = str(raw.clientNumber);
  const dateOfBirth = str(raw.dateOfBirth);
  const pin = str(raw.pin);
  const verifyUsing = str(raw.verifyUsing);
  if (!/^\d{9}$/.test(clientNumber)) throw new Error("the client number must be 9 digits");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new Error("the date of birth must be YYYY-MM-DD");
  if (!/^\d{4}$/.test(pin)) throw new Error("the PIN must be 4 digits");
  if (verifyUsing && verifyUsing !== "phone" && verifyUsing !== "email") throw new Error("verifyUsing must be phone or email");
  return { clientNumber, dateOfBirth, pin, ...(verifyUsing ? { verifyUsing: verifyUsing as "phone" | "email" } : {}) };
}

/**
 * MYMSD_CLIENT_NUMBER + MYMSD_DATE_OF_BIRTH + MYMSD_PIN (+ MYMSD_VERIFY_USING) in the environment win; otherwise the
 * credentials file; null when neither is set. A file that cannot be used is an error, not silence.
 */
export function loadPinCredentials(env: Record<string, string | undefined> = process.env): { source: PinSource; creds: PinCredentials } | null {
  if (env.MYMSD_CLIENT_NUMBER && env.MYMSD_DATE_OF_BIRTH && env.MYMSD_PIN) {
    const raw = { clientNumber: env.MYMSD_CLIENT_NUMBER, dateOfBirth: env.MYMSD_DATE_OF_BIRTH, pin: env.MYMSD_PIN, verifyUsing: env.MYMSD_VERIFY_USING };
    return { source: "env", creds: validatePinCredentials(raw) };
  }
  let text: string;
  try {
    text = readFileSync(CREDENTIALS_FILE, "utf8");
  } catch {
    return null;
  }
  try {
    return { source: "file", creds: validatePinCredentials(JSON.parse(text)) };
  } catch (e) {
    throw new Error(`${CREDENTIALS_FILE} is not usable (${(e as Error).message}): run mymsd-logon set again, or mymsd-logon clear`);
  }
}

export function savePinCredentials(raw: Record<string, unknown>): PinCredentials {
  const creds = validatePinCredentials(raw);
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(CREDENTIALS_FILE, 0o600);
  return creds;
}

export function clearPinCredentials(): void {
  rmSync(CREDENTIALS_FILE, { force: true });
}
