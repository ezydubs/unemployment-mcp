# mymsd-mcp — DES (new.my.msd.govt.nz) design

Companion to `2026-10-12-mymsd-mcp-design.md`. Facts and endpoint shapes: `NATIVE-NOTES.md` §11.

## 1. Purpose

MyMSD's dashboard hands job search, job matches, applying and the jobseeker profile to a second site, DES
("MyMSD new", `https://new.my.msd.govt.nz`). The user wants that site covered too, natively, from the same MCP server:
every endpoint the site uses becomes a tool, reads are free, writes are dry runs unless `confirm: true`, and the sign-in
keeps itself alive the same way the MyMSD part does.

## 2. Facts the design rests on (all tested 2026-10-12)

- DES is an AEM publish with a React SPA; its data API is eight servlets under `/bin/sep/` plus `/bin/bff/cv`. No F5
  challenge: a cold plain HTTP client reaches the public ones (search, job detail, locations).
- JSON API calls need the SPA's headers (`Accept`/`Content-Type: application/json`, same-origin `Referer` and `Origin`,
  `x-transaction-id`); POSTs without the Referer are refused by Sling's referrer filter (403).
- The sign-in servlets (`/bin/auth/login|renew|logout`, `/bin/auth-redirect`) refuse requests carrying
  `Sec-Fetch-Mode: cors`. Node's `fetch` always sets that header, so those hops are driven with `node:https`.
- Sign-in is OAuth 2 code + PKCE against MSD's Azure B2C (policy `b2c_1a_aem`): `/bin/auth/login?rt=` → B2C authorize →
  (answered from B2C's SSO cookie, or a person signs in) → `/bin/auth-redirect?code=` → the server exchanges the code and
  sets host-only session cookies (`__Host-a0/a1`, `__Host-ui`, `__Host-csrf`, `__Secure-i0/i1`). `POST /bin/auth/check`
  says whether the session is alive and for how long (`remaining` seconds; the site idles out after 14 minutes).
- B2C's SSO cookie lives on `identity.msd.govt.nz`, the same IdP the MyMSD part already keeps cookies for. Whether the
  DES policy honours the SSO established by a MyMSD (RealMe) sign-in is unknown until tested live; the design works either
  way (the repair fails cleanly and names the next step).
- `POST /bin/sep/vacancy-apply-submit?csrf=<__Host-csrf>` with `{ vacancyId, selectedCV: "existing"|"own",
  selectedReference: "Yes"|"No" }` is the whole apply flow. The SPA will not start it when the job is not Open, when it was
  already applied for, or when the client record carries a blocking special-caution token.
- The jobseeker profile is edited in an AEM adaptive-form wizard (`/en/forms/jsp`), not through an API; contact details
  are changed on MyMSD. Saved jobs, saved searches and job-notification settings are feature-flagged off in the SPA.

## 3. Architecture

Same server, same session file, same cookie jar. The jar already keeps cookies per host; DES adds `new.my.msd.govt.nz`
to the kept domains, so a Chrome import or a browser sign-in naturally carries both sites' cookies and the one B2C SSO
cookie serves both silent repairs.

| Unit | Responsibility |
|---|---|
| `src/paths.ts` | `DES_ORIGIN`; `DOMAINS` gains `new.my.msd.govt.nz`. |
| `src/des-http.ts` | `DesHttp`: `api()` (fetch with the SPA's headers, envelope parsing → data or `DesError` / `NotLoggedInError`), `nav()` (a navigation over an injectable transport, default `node:https`, no Sec-Fetch headers), `fetchFile()` (the CV), `csrfToken()` (the `__Host-csrf` cookie). |
| `src/des-oauth.ts` | `repairDes(http)`: the native OAuth replay — hop loop over `new.my.msd.govt.nz` ↔ `identity.msd.govt.nz`, auto-post forms submitted, dead ends (IdP sign-in page, DES error page, foreign host, 403, loop) become `SsoDeadError`. |
| `src/des-session.ts` | `DesSession`: check / ensure (memoised 60 s and never past `remaining`) / run-with-one-retry / status / forget / addCookies, mirroring `Session`. Owned by `Session` as `session.des`, persisted in the same `session.json` under `des`. |
| `src/browser.ts` | `harvestCookies` takes `site: "mymsd" | "des"`: the DES start page is `/bin/auth/login?rt=/my-jobs/` and readiness is `POST /bin/auth/check` → `authenticated`. |
| `src/tools/des.ts` | The nine `des_*` tools and their pure helpers (request builders, summaries, apply checks). |
| `src/server.ts` | Registers the DES module. |

Errors: `DesError(code, message, status, data)` for the site's envelope / unexplained statuses; `NotLoggedInError` for
401 and redirects (its message names `des_auth`); `SsoDeadError` inside the repair only. Tool text: `Error: …` with the
DES sign-in hint when the session is the problem.

## 4. Tools

Public (no sign-in; still use the session cookies when present so `des_job` can show the application status):

| Tool | Endpoint | Input |
|---|---|---|
| `des_search` | `POST /bin/sep/vacancies/search` | `query?` (≤ 50), `occupationGroups?` (codes BLD BAO CRE EDU HSC MFG RSH SEA SEC TLW), `regions?`, `districts?` (names from `des_locations`; ≤ 10 together), `limit?` (summary lines, default 20). At least one of query/groups/locations. |
| `des_job` | `GET /bin/sep/vacancies/details?vacancyId=` | `id`. Full detail incl. description as text; with a session also "You applied …" and any special-caution flag. |
| `des_locations` | `GET /bin/sep/v10/refdata.json?category=userLocations&q=&mode=startswith` | `query`. Island → region → district → suburb tree, flattened with the level named. |

Signed in:

| Tool | Endpoint | Input / behaviour |
|---|---|---|
| `des_auth` | `/bin/auth/check`; Chrome cookies; browser | `status` (default), `import_chrome` (new.my.msd.govt.nz + identity + RealMe cookies; empty values dropped), `login` (CloakBrowser window at the DES sign-in when installed, else opens it in the user's browser and says to run `import_chrome`), `forget` (drops the DES cookies and state only). |
| `des_matches` | `GET /bin/sep/vacancies/match?limit=` | `limit?` (default 10). 404 = none. |
| `des_profile` | `GET /bin/sep/client-profile` + `GET /bin/sep/jobseeker-profile` | Each part tolerant; mentions where editing happens. |
| `des_applications` | `GET /bin/sep/job-applications` | List with stage and date. |
| `des_apply` | `POST /bin/sep/vacancy-apply-submit?csrf=` | `id`, `cv` ("existing" = the CV MSD holds, "own" = reply to the confirmation email with it), `reference` ("Yes"/"No"), `confirm`. Fetches the detail first and refuses when already applied, not Open, past the closing date, or a blocking special-caution token is present (the same tokens the SPA checks). Dry run shows the exact request. |
| `des_cv` | `GET /bin/bff/cv` | `path?` (default: the temp dir, named from Content-Disposition). |

Every tool returns summary lines then the JSON (the `result()` helper).

## 5. Session lifetime

`DesSession.ensure()` trusts a good check for 60 s and only while `remaining` has more than 30 s left; otherwise it
checks again, and when the session has ended it runs `repairDes` once (needs the B2C SSO cookie in the jar; without it
the error says to sign in). `run(fn)` retries a call once after a 401 when a repair happened meanwhile. No automatic
renew loop: the next tool call repairs on demand, which is the same promise the MyMSD part makes.

## 6. Testing

Unit tests (`node --test`, mocked `fetch` and an injected `navigate` transport): header rules and envelope parsing; the
OAuth hop loop (happy path, selection page, auto-post form, error page, 403, foreign host, loop); session memo / repair /
concurrent callers / retry / persistence inside `session.json`; every pure helper (search body limits, summaries, HTML
to text, apply checks, locations flattening); the browser start URL. Live: `npm run smoke` gains the DES calls (public
ones always, the rest once signed in), apply stays a dry run.

## 7. Out of scope

Profile editing (the AEM wizard), contact-preference changes (MyMSD), saved jobs / searches / notifications (off in the
SPA), `/bin/auth/logout` (never call it: it ends B2C's session too).
