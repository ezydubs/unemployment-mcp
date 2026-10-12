import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browserAvailable, harvestCookies, openInChrome } from "../browser.js";
import { readChromeCookies } from "../chrome-cookies.js";
import { loadPinCredentials } from "../credentials.js";
import { result } from "../format.js";
import { DOMAINS, ORIGIN } from "../paths.js";
import type { Session } from "../session.js";
import { dryRun, fail, tolerant } from "./common.js";

const whoami = (s: Session) =>
  s.info?.isAuthenticated ? `Signed in to MyMSD as ${s.info.firstName} (client ${s.info.clientNumber}); last login ${s.info.lastLogin ?? "unknown"}.` : "Not signed in to MyMSD.";

export function register(server: McpServer, session: Session): void {
  server.registerTool(
    "mymsd_auth",
    {
      description:
        "Sign-in state and sign-in actions for MyMSD. status: who is signed in and what cookies are held. " +
        "import_chrome: take the sign-in from Google Chrome's Default profile (be signed in at my.msd.govt.nz there; macOS asks once for Keychain access — choose Always Allow). " +
        "login: open a browser window to sign in with RealMe (uses the optional CloakBrowser when installed; otherwise opens my.msd.govt.nz in your own browser, after which you run import_chrome). " +
        "login_pin: sign in with client number, date of birth and 4-digit PIN — or with no details at all when a PIN sign-in is stored (the mymsd-logon set command, or MYMSD_CLIENT_NUMBER/MYMSD_DATE_OF_BIRTH/MYMSD_PIN in the environment); if MyMSD then asks to verify the device, call again with the code it sent. " +
        "forget: delete the saved session (does not sign you out of RealMe). forget_remembered_client / forget_login_method: MyMSD's own 'log in as someone else' and 'forget my preferred login method' for this device. " +
        "The session repairs itself silently while your RealMe sign-in lasts, and after that with the stored PIN sign-in when there is one.",
      inputSchema: {
        action: z.enum(["status", "import_chrome", "login", "login_pin", "forget", "forget_remembered_client", "forget_login_method"]).default("status"),
        chromeProfile: z.string().optional().describe('Chrome profile folder, default "Default"'),
        clientNumber: z.string().regex(/^\d{9}$/).optional().describe("login_pin: 9-digit client number"),
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("login_pin: YYYY-MM-DD"),
        pin: z.string().regex(/^\d{4}$/).optional().describe("login_pin: 4-digit PIN"),
        rememberMe: z.boolean().optional().describe("login_pin: remember this client on this device (default true)"),
        code: z.string().regex(/^\d{6}$/).optional().describe("login_pin: the 6-digit device-verification code MyMSD sent"),
        verifyUsing: z.enum(["phone", "email"]).optional().describe("login_pin: where to send the device-verification code"),
        confirm: z.boolean().default(false).describe("forget_remembered_client / forget_login_method: these change how you sign in on this device; dry run unless true"),
      },
    },
    async (args) => {
      try {
        switch (args.action) {
          case "status": {
            if (session.jar.has("my.msd.govt.nz")) await session.ensure().catch(() => {});
            const pendingSso = session.info?.isAuthenticated ? await tolerant(session.http.get("/rest/sso-session")).catch(() => null) : null;
            const st = session.status();
            return result([whoami(session), `PIN sign-in stored: ${st.pinCredentials}. Optional browser installed: ${await browserAvailable()}`], { ...st, pendingSso });
          }
          case "import_chrome": {
            const cookies = await readChromeCookies({ profile: args.chromeProfile, domains: DOMAINS });
            if (!cookies.some((c) => c.domain.endsWith("my.msd.govt.nz"))) {
              return fail(new Error("Chrome holds no my.msd.govt.nz cookies. Sign in at my.msd.govt.nz in Chrome, then run this again."));
            }
            session.addCookies(cookies);
            const info = await session.ensure(true);
            return result([`Imported ${cookies.length} cookies from Chrome. ${whoami(session)}`], {
              imported: cookies.map((c) => `${c.domain} ${c.name}`),
              signedIn: info.isAuthenticated,
            });
          }
          case "login": {
            if (await browserAvailable()) {
              const cookies = await harvestCookies({ jar: session.jar, headless: false, waitForAuth: true, timeoutMs: 5 * 60_000 });
              session.addCookies(cookies);
              await session.ensure(true);
              return result([`Signed in through the browser window. ${whoami(session)}`], session.status());
            }
            await openInChrome(`${ORIGIN}/`);
            return result(["Opened my.msd.govt.nz in your browser. Sign in there, then run mymsd_auth import_chrome."], { browserInstalled: false });
          }
          case "login_pin": {
            if (args.code) {
              const info = await session.verifyDevice(args.code, args.rememberMe ?? true);
              return result([`Device verified. ${whoami(session)}`], { verifiedDevice: info.verifiedDevice });
            }
            const given = args.clientNumber && args.dateOfBirth && args.pin ? { clientNumber: args.clientNumber, dateOfBirth: args.dateOfBirth, pin: args.pin, verifyUsing: args.verifyUsing } : null;
            const stored = given ? null : loadPinCredentials();
            if (!given && !stored) {
              return fail(
                new Error(
                  "login_pin needs clientNumber, dateOfBirth and pin — or a stored PIN sign-in (run: mymsd-logon set <client number> <YYYY-MM-DD> <pin>) — or code after a verification code was sent",
                ),
              );
            }
            const r = await session.loginWithPin(given ?? stored!.creds, { rememberMe: args.rememberMe ?? true });
            if (r.signedIn) return result([`Signed in with PIN${stored ? ` (stored, ${stored.source})` : ""}. ${whoami(session)}`], { verifiedDevice: r.info.verifiedDevice, source: stored?.source ?? "arguments" });
            return result([`MyMSD sent a verification code to your ${r.sentTo}. Call mymsd_auth login_pin again with code (or run: mymsd-logon verify <code>).`], {
              verificationSentTo: r.sentTo,
              clientDetails: r.clientDetails,
            });
          }
          case "forget":
            session.forget();
            return result(["Saved MyMSD session deleted."], { sessionFile: session.status().sessionFile });
          case "forget_remembered_client": {
            const request = { method: "POST" as const, path: "/rest/session/forget-me" };
            const effect = "MyMSD will no longer remember this client on this device (the client number must be typed at the next PIN sign-in)";
            if (!args.confirm) return dryRun(request, effect);
            const r = await session.http.post(request.path);
            return result([`Done. ${effect}.`], { response: r, request });
          }
          case "forget_login_method": {
            const request = { method: "POST" as const, path: "/rest/session/forget-remember-me" };
            const effect = "MyMSD will forget the preferred login method for this device";
            if (!args.confirm) return dryRun(request, effect);
            const r = await session.http.post(request.path);
            return result([`Done. ${effect}.`], { response: r, request });
          }
        }
      } catch (e) {
        return fail(e);
      }
    },
  );
}
