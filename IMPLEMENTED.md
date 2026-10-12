# What was implemented — 2026-10-12

Project: `/Users/test/Downloads/mymsd-mcp` — one MCP server (`mymsd` in `~/.claude.json`) covering both MSD sites,
over their own HTTP APIs, no browser in the loop. Run tests with `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test`.

## Part 1 — MyMSD (my.msd.govt.nz) — on `main`

42 tools, all `mymsd_*`: 1 auth, 21 reads, 20 writes (every write is a dry run unless `confirm: true`). 70 unit
tests. Reviewed, fix pass applied, merged. Details in `STATUS.md`, `README.md`, `NATIVE-NOTES.md` §1–10.

## Part 2 — DES, the jobs site (new.my.msd.govt.nz, "MyMSD new") — branch `des`

### Files added / changed

| File | What it does |
|---|---|
| `src/paths.ts` | `DES_ORIGIN`; `new.my.msd.govt.nz` added to the kept cookie domains. |
| `src/des-http.ts` | `DesHttp`: JSON API calls with the SPA's headers (same-origin Referer + Origin, `x-transaction-id`), envelope parsing (`results`/`result`, 401 → not signed in, site errors → `DesError`), `nav()` for sign-in navigations over `node:https` (Node's `fetch` forces `Sec-Fetch-Mode: cors`, which DES's login servlet refuses), `fetchFile()` for the CV, `csrfToken()` from the `__Host-csrf` cookie. |
| `src/des-oauth.ts` | `repairDes()`: the native silent sign-in — `/bin/auth/login` → B2C authorize (answered from the identity provider's SSO cookie) → `/bin/auth-redirect?code=` → return page. Dead ends (IdP sign-in page, DES error page, a host we do not drive, 403, redirect loop) become `SsoDeadError`. |
| `src/des-session.ts` | `DesSession`: `POST /bin/auth/check` as the probe, memo for 60 s and never past `remaining`, one shared repair for concurrent callers, retry-once after a 401, `addCookies` (drops empty values), `forget` (DES cookies only), `status()` without secrets. |
| `src/session.ts` | `Session.des` — the DES session shares the MyMSD jar and is saved in the same `session.json` under `des`. |
| `src/browser.ts` | `harvestCookies({ site: "des" })` opens DES's login servlet in the CloakBrowser window and waits for `/bin/auth/check` to say signed in; `harvestStart(site)`. |
| `src/tools/des.ts` | The nine tools and their pure helpers (search body + limits, summaries, HTML → text, apply checks, locations flattening). |
| `src/server.ts` | Registers the DES module. |
| `scripts/smoke.mjs` | DES calls appended; `SMOKE_ONLY=des` runs just them. |
| `NATIVE-NOTES.md` §11 | Transport rules, auth flow, cookies, every endpoint's request and response shape (all tested live where no sign-in is needed). |
| `README.md`, `STATUS.md` | DES sections. |
| `docs/superpowers/specs/2026-10-12-des-design.md`, `docs/superpowers/plans/2026-10-12-des.md` | Design and the 7-task plan that was executed. |

### Tools

| Tool | Needs sign-in | What it does |
|---|---|---|
| `des_search` | no | `POST /bin/sep/vacancies/search` — words, occupation groups (BLD BAO CRE EDU HSC MFG RSH SEA SEC TLW), region/district names; the site's limits enforced before anything is sent. |
| `des_job` | no (more when signed in) | `GET /bin/sep/vacancies/details?vacancyId=` — full detail, description as text; with a session also "You applied …" and any special-caution flag. |
| `des_locations` | no | `GET /bin/sep/v10/refdata.json?category=userLocations&q=&mode=startswith` — island → region → district → suburb, names to use in `des_search`. |
| `des_matches` | yes | `GET /bin/sep/vacancies/match?limit=` — the site's 404 means "none". |
| `des_profile` | yes | `GET /bin/sep/client-profile` + `GET /bin/sep/jobseeker-profile`, each part tolerant. |
| `des_applications` | yes | `GET /bin/sep/job-applications` with stages. |
| `des_apply` | yes | `POST /bin/sep/vacancy-apply-submit?csrf=` with `{ vacancyId, selectedCV: existing/own, selectedReference: Yes/No }` — fetches the detail first and refuses when already applied, not Open, closed, or the record carries the blocking flag the site checks. **Dry run unless `confirm: true`; the dry run masks the csrf token.** |
| `des_cv` | yes | `GET /bin/bff/cv` saved to a file. |
| `des_auth` | — | `status`, `import_chrome` (DES + identity-provider + RealMe cookies from Chrome, empty values dropped), `login` (CloakBrowser window, or your own browser then `import_chrome`), `forget` (DES only). |

### Tests

39 new unit tests (109 total, all green): transport header rules and envelope parsing; the OAuth hop loop (happy
path, IdP selection page, auto-post form, error page, 403, foreign host, loop, odd status); session memo / `remaining`
/ concurrent repair / 401-as-no-session / dead SSO / retry / persistence; every pure helper; the tools through a fake
server with a scripted network (public fallback, validation before any request, apply dry run and refusals, apply
with confirm, matches 404, CV save, auth status/forget).

### Verified live (no sign-in needed)

`des_locations` ("auck" → the Auckland tree), `des_search` ("cleaner" in Auckland Region → 8 jobs with pay, place,
closing date, link), `des_job` (full detail with description). The signed-in tools answer "No DES session" with the
sign-in hint until a DES session exists.

### Not yet verified live

The signed-in tools and the silent sign-in replay — a DES sign-in is needed once. The RealMe sign-in attempted in the
cloakbrowser window was refused by DES itself ("your account isn't able to access this system", `code=idp_error`);
"Log in with MyMSD" on DES's chooser, or a MyMSD dashboard link into DES, is the next thing to try. No job application
has been sent.

### Fresh review (whole branch) and the fix pass

Critical: none. Important (fixed, each with a test that failed first): a timeout on the sign-in hops; the public
fallback now runs anonymously (no dead session cookies re-sent); `des_apply` refuses when the job's status is missing,
not only when it is something other than Open; the CV file name from the server is reduced to its base name and
decoded only in its RFC 5987 form; a confirmed `des_apply` whose POST loses the session is **not** re-sent (it says to
check `des_applications` instead). Minor findings are recorded in the plan ledger as deferred.
