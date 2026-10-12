# MyMSD MCP — status and what's needed (2026-10-12, evening)

## 1. What exists and works

- **The MCP is built, tested and registered.** `/Users/test/Downloads/mymsd-mcp`, branch `build` (not merged to `main`
  yet). Registered in `~/.claude.json` as `mymsd` — new Claude Code sessions get it (or `/mcp` reconnect).
- **42 tools**, all `mymsd_*`: 1 auth, 21 reads, 20 writes. Every write is a dry run unless `confirm: true`.
- **70 unit tests pass** (`npm test`). A fresh code review was done; its two serious findings (wrong accommodation-cost
  payload shape, an invented key in the hardship payload) plus eleven smaller ones are fixed and committed.
- **Live smoke was green** while your sign-in was alive: all reads returned your real data (dashboard, benefits,
  letters + PDF, debt, finance, card, appointments, income, employment plan, jobs, one-off costs, medical certificate,
  housing, applications), all writes stopped at their dry run.
- **No real write has been sent yet.** Nothing on your MSD account has been changed by this work.

## 2. What's going wrong: the sign-in keeps dying, and it is MyMSD doing it

The MCP signs in by copying your sign-in from Chrome, then keeps itself signed in by silently repeating the RealMe
single-sign-on when MSD's 15-minute session expires. That silent repeat only works while MSD's identity provider still
has your sign-in.

**MyMSD's own web page ends that sign-in.** If a MyMSD tab is left open anywhere (Chrome, the cloakbrowser window),
its 15-minute idle timer runs a *single logout* that signs you out of RealMe for every app — including the MCP.
Evidence from Chrome's cookie database: you signed in at 04:37:59 UTC (16:37 NZ), the MyMSD tab fired at 04:53:11 UTC,
exactly 15 minutes later, and the identity-provider cookies vanished. The MCP's repair then correctly reported
"session has ended and silent sign-in failed". The same thing happened earlier with the cloakbrowser tab.

**Right now the MCP is not signed in.**

### Two ways to make this stop being a problem

1. **Habit fix (no code):** after signing in at my.msd.govt.nz, close the tab. The MCP then stays signed in on its own
   for as long as MSD's identity provider remembers you (unknown how long; likely hours).
2. **Proper fix (small code change, your call):** a PIN fallback. MyMSD also supports "client number + date of birth
   + 4-digit PIN" and remembers the device (the `longLivedCookie` / `verifiedDeviceCookie` cookies it already set).
   With a PIN, the MCP can sign in natively with no RealMe involvement at all, so an idle tab can't break it. You would
   need to set a PIN up in MyMSD (it's under the login options) and the MCP would keep it in the macOS Keychain, not
   in a file. Say yes/no.

## 3. What I need from you (in order)

1. **Close every MyMSD tab**, then sign in once more at https://my.msd.govt.nz in Chrome, **then close that tab**.
   Tell me "signed in" and I'll import it (`mymsd_auth import_chrome`) and re-run the live checks.
2. **Decide on the PIN fallback** (section 2, option 2): yes or no.
3. **Pick the first real writes to verify.** Reversible ones first; I'll show each dry run and send only on your yes:
   letters by post ↔ email, then a work-email change and revert, then book + cancel a phone appointment.
4. **DES (jobs site):** see section 4. If you want it, the cloakbrowser window is sitting on MSD's "Log in" chooser
   for the jobs site; signing in there lets me capture the exact sign-in flow and then build the tools. If you don't
   want it now, say so and I'll leave it.

## 4. DES — the jobs site (new.my.msd.govt.nz): what I found

- It is a separate site (Adobe Experience Manager + a React app). Its whole API is eight calls:
  `vacancies/search` (POST: searchTerms, filters.locations/industries), `vacancies/match?limit=`, `vacancies/details?vacancyId=`,
  `vacancy-apply-submit?csrf=`, `job-applications`, `client-profile`, `jobseeker-profile`, `refdata` — all under `/bin/sep/`.
  The jobseeker-profile *editing* wizard is a separate form at `/en/forms/jsp` (not mapped yet).
- Sign-in is Microsoft B2C again (same MSD tenant as MyMSD, different policy `b2c_1a_aem`, OAuth code + PKCE,
  `/bin/auth/login` → B2C → `/bin/auth-redirect` → DES session cookie). Its silent sign-in is a hidden-iframe
  `prompt=none` check — so it also depends on the same identity-provider session that MyMSD's idle logout kills.
- **Unresolved:** the server answers my native `/bin/auth/login` with `403 {"ok":false,"error":"forbidden"}` while the
  browser's identical-looking request gets the expected redirect. I captured the browser's request headers and will
  compare; worst case DES tools get their session from a Chrome import of `new.my.msd.govt.nz` cookies, like MyMSD.
- Building it: roughly 10 tools (search, matches, job detail, apply, my applications, profiles, refdata, status),
  same dry-run rules. Needs you signed in to DES once so I can see real response shapes.

## 5. Where everything is

| thing | path |
|---|---|
| code | `/Users/test/Downloads/mymsd-mcp/src/` (tools in `src/tools/`) |
| tests / live smoke | `npm test` · `SMOKE_IMPORT=1 npm run smoke` (imports your Chrome sign-in first) |
| API notes (every endpoint, payload shapes, auth findings) | `NATIVE-NOTES.md` |
| design spec / plan | `docs/superpowers/specs/2026-10-12-mymsd-mcp-design.md` · `docs/superpowers/plans/2026-10-12-mymsd-mcp.md` |
| work ledger (every decision I made, every fix) | `.superpowers/sdd/2026-10-12-mymsd-mcp/progress.md` |
| saved session (cookies only, mode 600) | `~/.mymsd-mcp/session.json` |
| DES bundle analysis / spikes | `/private/tmp/claude-501/.../scratchpad/des/` · `.superpowers/sdd/.../spike-des*.mjs` |

## 6. Next steps, in order

1. You sign in again (and close the tab) → I import → live checks green again.
2. Prove the silent re-login live (needs 15 idle minutes with no MyMSD tab open anywhere).
3. Merge `build` into `main`.
4. Real writes with you, one at a time.
5. PIN fallback if you say yes.
6. DES tools if you say yes.


## DES (new.my.msd.govt.nz, "MyMSD new") — added 2026-10-12, later the same day

- **Built and tested:** 9 `des_` tools on branch `des` (search, job, locations, matches, profile, applications, apply,
  CV download, auth), 39 new unit tests (109 total, green). Native all the way: the only trick needed was using
  `node:https` for the sign-in hops, because Node's `fetch` adds a header DES's login servlet refuses.
- **Verified live:** `des_locations`, `des_search` and `des_job` return real data without any sign-in. The signed-in
  tools correctly say "No DES session" until there is one.
- **Not yet verified live:** the signed-in tools and the silent sign-in replay. A DES sign-in is needed once (Chrome at
  new.my.msd.govt.nz then `des_auth import_chrome`, or `des_auth login`). In the cloakbrowser window a RealMe sign-in
  came back from DES with "We couldn't log you in right now — your account isn't able to access this system"
  (`error/login?code=idp_error`): that is DES refusing, not the MCP. Try "Log in with MyMSD" on DES's login chooser, or
  open DES from a MyMSD dashboard link.
- **No application has been sent.** `des_apply` stops at its dry run (and refuses on its own when a job is not open,
  already applied for, closed, or the record carries a blocking flag).
