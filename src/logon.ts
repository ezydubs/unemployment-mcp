#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { CREDENTIALS_FILE, clearPinCredentials, loadPinCredentials, savePinCredentials } from "./credentials.js";
import { Session } from "./session.js";

export const USAGE = `mymsd-logon — sign in to MyMSD with your client number, date of birth and PIN, stored once so the MCP server
signs in by itself whenever MSD's single sign-on has lapsed.

  mymsd-logon set <client number> <YYYY-MM-DD> <pin> [phone|email]   store the sign-in (file mode 600) and sign in now
  mymsd-logon login                                                   sign in now with the stored details
  mymsd-logon verify <code>                                           finish with the 6-digit device code MyMSD sent
  mymsd-logon status                                                  what is stored (never the values) and who is signed in
  mymsd-logon clear                                                   delete the stored details (the saved session stays)

MYMSD_CLIENT_NUMBER, MYMSD_DATE_OF_BIRTH and MYMSD_PIN (plus MYMSD_VERIFY_USING) in the environment are used instead of
the file when all three are set. Stored in ${CREDENTIALS_FILE}.`;

type Out = (line: string) => void;
const mask = (clientNumber: string): string => `••••••${clientNumber.slice(-3)}`;

async function login(out: Out): Promise<number> {
  const stored = loadPinCredentials();
  if (!stored) {
    out("No PIN sign-in stored: mymsd-logon set <client number> <YYYY-MM-DD> <pin>.");
    return 1;
  }
  const session = Session.load();
  const r = await session.loginWithPin(stored.creds);
  if (r.signedIn) {
    out(`Signed in to MyMSD as ${r.info.firstName} (client ${mask(r.info.clientNumber)}). A running MCP server picks this up on its next call.`);
    return 0;
  }
  out(`MyMSD wants to verify this device: a code was sent to your ${r.sentTo}. Run: mymsd-logon verify <code>`);
  return 0;
}

/** The command; returns the exit code. `out` receives the lines (console.log by default). */
export async function main(argv: string[], out: Out = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "set": {
        const [clientNumber, dateOfBirth, pin, verifyUsing] = rest;
        if (!clientNumber || !dateOfBirth || !pin) break;
        const creds = savePinCredentials({ clientNumber, dateOfBirth, pin, verifyUsing });
        out(`Stored the PIN sign-in for client ${mask(creds.clientNumber)} in ${CREDENTIALS_FILE} (mode 600). The MCP server signs in with it by itself from now on.`);
        return await login(out);
      }
      case "login":
        return await login(out);
      case "verify": {
        const code = rest[0] ?? "";
        if (!/^\d{6}$/.test(code)) break;
        const info = await Session.load().verifyDevice(code);
        out(`Device verified. Signed in to MyMSD as ${info.firstName} (client ${mask(info.clientNumber)}).`);
        return 0;
      }
      case "status": {
        const stored = loadPinCredentials();
        out(stored ? `PIN sign-in stored (${stored.source}) for client ${mask(stored.creds.clientNumber)}.` : "No PIN sign-in stored.");
        const st = Session.load().status();
        out(st.signedIn ? `Session file: signed in as ${st.firstName} (last checked ${st.checkedAt}).` : "Session file: not signed in.");
        if (st.pendingVerification) out(`A device-verification code was sent to your ${st.pendingVerification}: mymsd-logon verify <code>.`);
        return 0;
      }
      case "clear":
        clearPinCredentials();
        out("Deleted the stored PIN sign-in. The saved session is kept.");
        return 0;
    }
  } catch (e) {
    out(`Error: ${(e as Error).message}`);
    return 1;
  }
  out(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
