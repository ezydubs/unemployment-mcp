# mymsd-mcp — design

Date: 2026-10-12. Status: approved in conversation (sections 1–6 below), awaiting written-spec review.

## 1. Purpose

An MCP server that lets Claude operate the user's own MyMSD account (my.msd.govt.nz, Ministry of Social
Development, New Zealand) in full: every read the site offers (payments, benefits, letters, debt, cards,
appointments, income, employment plan, applications, housing) and every action (declare wages, book/cancel
appointments, update contact/address/accommodation details, letters preferences, job-search log, card PIN, document
upload, and the application flows: one-off costs/hardship, Housing Register check-in, emergency housing, TAS,
medical-certificate ready-to-work, benefit-application steps).

Success looks like: a tool call answers in well under a second from plain HTTP; the session repairs itself without
the user noticing for as long as their RealMe/B2C sign-in lives; when it cannot, the error says exactly which
`mymsd_auth` action fixes it; no write ever happens without `confirm: true`, and the dry run shows the exact request.

What the user said: "make an MCP for my.msd.govt.nz, logged in, all site functionality", "make it as native as
possible", re-login via both a browser window and a Chrome import, everything including applying.
Assumptions (correctable): one account per machine; NZ dates/amounts shown as the site gives them; the external
DES (new.my.msd.govt.nz) and MyAccount (services.workandincome.govt.nz) sites are linked, not driven.

## 2. Constraints and facts the design rests on

All from `NATIVE-NOTES.md` (verified 2026-10-12):

- The API is `https://my.msd.govt.nz/rest/*` (Ember Data REST), JSON, same-origin headers
  `X-Requested-With: XMLHttpRequest`, `Content-Type: application/json; charset=utf-8`; every POST body carries the
  `csrfToken` from `GET /rest/session`. Error envelope `{error:{code,message,data}}`.
- F5 bot defence ("TSPD"): any request without the JS-computed token cookies gets a 200 `text/html` challenge page
  (`window["bobcmn"]…`). The token cannot be computed natively; replaying the cookies the challenge hands out does
  not help (tested). With the cookies a real browser obtained, plain Node requests pass (tested).
  `/saml2/authenticate/ciam` is served unchallenged.
- Session: `JSESSIONID` ~2 h, 15-min idle timeout, `GET /rest/session` reports `isAuthenticated`. Silent re-login:
  `GET /idpsaml/ciamsession` → `/saml2/authenticate/ciam` (auto-post SAML form) → Azure B2C
  `identity.msd.govt.nz/.../samlp/sso/login` (answers without UI while its `x-ms-cpim-sso` cookie lives) →
  `POST /session/login/samlResponse` → 302 `/realme/callback?status=success`.
- Chrome's Default profile cookie DB holds everything needed (F5 cookies, `JSESSIONID`, `longLivedCookie`,
  `verifiedDeviceCookie`, B2C SSO cookies for identity.msd.govt.nz and login.realme.govt.nz). Chrome's DB meta
  version is 24 → values are `v10` + AES-128-CBC, plaintext prefixed by SHA-256(host_key) (32 bytes).
- node@24 (`/opt/homebrew/opt/node@24/bin/node`) has built-in `node:sqlite`.
- House conventions (seek-mcp, homes-co-nz-mcp): TypeScript, `@modelcontextprotocol/sdk`, `zod` v4, tools return
  text "summary first, then JSON", `*_auth` tool with `import_chrome`, `node --test test/*.test.mjs`,
  `scripts/smoke.mjs`, `NATIVE-NOTES.md`, README, registered in `~/.claude.json`.
- Never call `/idpsaml/saml/manual-slo` (SAML single logout): it ends the IdP session that silent re-login relies on.

## 3. Architecture

Runtime dependencies: `@modelcontextprotocol/sdk`, `zod`. Optional dependencies (`optionalDependencies`, loaded with
dynamic `import()` only when needed): `cloakbrowser`, `playwright-core` — used solely for the two things HTTP cannot
do: obtain F5 token cookies headlessly, and host a visible sign-in window.

```
src/server.ts        McpServer "mymsd"; registers every tool module; ok()/fail() helpers (hint on NotLoggedInError)
src/jar.ts           CookieJar: domain/path/secure matching, Set-Cookie parsing, expiry, JSON (de)serialisation
src/chrome-cookies.ts readChromeCookies(domains, profile): copy Cookies DB → node:sqlite → Keychain key → decrypt
src/session.ts       SessionStore (~/.mymsd-mcp/session.json, 0600) + Session.ensure() / repair logic
src/sso.ts           native SAML dance: parseAutoPostForm(html), followAutoPost(...), repairSso(jar)
src/browser.ts       optional CloakBrowser: harvestCookies({headless}), interactiveLogin()
src/http.ts          api.get/post/postForm/upload/delete/download; challenge detection; error classes
src/format.ts        money/date/summary helpers; result(summary, data) → MCP text content
src/tools/auth.ts    mymsd_auth
src/tools/*.ts       one file per area (dashboard, profile, benefits, letters, money, appointments, income,
                     employment, jobs, hardship, housing, applications, lookups, tas, medical); each exports register()
test/*.test.mjs      offline tests on redacted fixtures
scripts/smoke.mjs    live run: every read tool, every write tool as dry run
NATIVE-NOTES.md      the API notes (already written)
README.md            install, auth, tool list
```

Each unit's contract:

- **CookieJar** — `header(url)`, `store(url, setCookieHeaders)`, `add(cookie[])`, `has(domain)`, `toJSON()/fromJSON()`.
  Pure; tested offline.
- **chrome-cookies** — `readChromeCookies({ profile = "Default", domains })` → `Cookie[]`. Copies the DB to a temp
  file (Chrome keeps it locked), reads `cookies` + `meta.version` with `node:sqlite`, gets the password with
  `security find-generic-password -w -s "Chrome Safe Storage"` (one macOS Keychain prompt; "Always Allow" ends them),
  derives the key with PBKDF2-SHA1("saltysalt", 1003, 16), decrypts `v10` values with AES-128-CBC (IV = 16 spaces),
  strips the 32-byte host hash when `meta.version >= 24`, converts `expires_utc` (µs since 1601) to epoch seconds
  (0 = session). Decryption is tested offline with a synthetic DB encrypted by the test itself.
- **sso** — `parseAutoPostForm(html)` → `{ action, fields }` (first `<form method="post">` with hidden inputs);
  `repairSso(api)` runs the dance with a generic follower: start at `ciamsession.redirectUrl`, follow up to 5
  auto-post forms whose action host is one of my.msd.govt.nz / identity.msd.govt.nz / login.realme.govt.nz, stop
  when a form targets `/session/login/samlResponse` (post it, expect 302 to `/realme/callback`), fail with
  `SsoDeadError` if a hop returns a page without such a form (the IdP wants interactive sign-in) or the callback
  `status` is not `success` (carry the realme error code).
- **Session** — `ensure()`:
  1. no cookies for my.msd.govt.nz in the jar → `NotLoggedInError("run mymsd_auth import_chrome or mymsd_auth login")`.
  2. `GET /rest/session`. Challenge page → `repairChallenge()`: if `cloakbrowser` resolves, headless harvest
     (persistent profile `~/.mymsd-mcp/profile` seeded with the jar, load `/dashboard`, wait until an in-page
     `fetch('/rest/session')` returns JSON or 15 s, copy all cookies for the three domains into the jar); else
     `BotDefenceError("F5 challenge; run mymsd_auth import_chrome after opening my.msd.govt.nz in Chrome")`. Retry once.
  3. `isAuthenticated` → store `csrfToken`, `firstName`, `clientNumber`, `checkedAt`; done.
  4. otherwise `repairSso()` then `GET /rest/session` again; still not authenticated → `NotLoggedInError` naming the
     cause (`SsoDeadError` → "sign in again: mymsd_auth login or import_chrome").
  `ensure()` is memoised for 60 s of successful checks so a burst of calls costs one session GET; any `unauthenticated`
  (401) from a data call clears the memo, repairs once and retries that call once.
  The jar is written back after every response that set cookies (F5 rotates `TSeae47ed5027`).
- **http** — `api.get(path, params?)`, `api.post(path, body)` (injects `csrfToken`), `api.postForm(url, fields)`,
  `api.upload(path, files[], metaData?)` (multipart: `file`/`file1..N` + `meta-data` JSON with `csrfToken`),
  `api.delete(path)`, `api.download(path, toPath)` (streams a PDF; returns path, bytes, content-type). Response
  handling mirrors the site's ajax util: 204 → null, JSON → object, text/html → challenge check → `BotDefenceError`
  or, for 403, `NotPermittedError("not available on this account")`. The envelope maps to
  `MsdError{ code, message, data, status }`; `unauthenticated` → `NotLoggedInError`.
- **browser** — `interactiveLogin()`: `launchPersistentContext({ userDataDir: ~/.mymsd-mcp/profile, headless: false })`,
  open `https://my.msd.govt.nz/`, poll every 2 s (in-page `fetch('/rest/session')`) until `isAuthenticated` or 5 min,
  harvest cookies, close. Without `cloakbrowser` installed, `login` runs `open https://my.msd.govt.nz/` (the user's
  Chrome) and returns "sign in there, then run mymsd_auth import_chrome".
- **format** — `nzd(n)`, `date(s)` (adds the weekday to ISO dates), `result(summaryLines[], data)`.

Data flow for a tool call: zod-validated args → `session.ensure()` → one or more `api.*` calls (independent ones in
parallel) → summariser → `result()`. Tools never touch the jar or cookies directly.

## 4. Tools

All tools are prefixed `mymsd_`. Read tools take only filters. Every write tool takes `confirm: boolean` (default
false); with `confirm: false` it validates and returns `{ dryRun: true, request: { method, path, body }, effect: "…" }`
and sends nothing; with `confirm: true` it sends and returns the site's response plus a one-line statement of what was
recorded. Descriptions of tools this account cannot exercise carry "untested on this account".

### 4.1 Auth

`mymsd_auth` — `action`: `status` (jar domains, csrf present, last successful check, cloakbrowser installed?) ·
`import_chrome` (`chromeProfile?` default "Default"; imports cookies for my.msd.govt.nz, identity.msd.govt.nz,
login.realme.govt.nz, then `ensure()`; reports who is signed in) · `login` (browser window or Chrome hand-off, see
§3) · `login_pin` (`clientNumber`, `dateOfBirth` YYYY-MM-DD, `pin`, `rememberMe?`; `POST /session/login/pin` then
`ensure()`; if `redirectUrl` is `/login/verify-device` or `verifiedDevice` is false, runs
`POST /rest/logon/verifydevice/send-code` and returns "code sent to …"; a second call with `code` posts
`verify-code`) · `forget` (delete `session.json`; never calls the SAML logout).

### 4.2 Read tools (endpoints in NATIVE-NOTES §6)

| tool | inputs | calls |
|---|---|---|
| `mymsd_dashboard` | — | session, client (flags only), benefits/summary, notifications, appointments, letters/notification, banners, tiles, cyc-status, engagement-status (parallel) |
| `mymsd_profile` | — | client (contact details, addresses, Community Services Card, partner/children, living situation, flags, features) |
| `mymsd_benefits` | `detail?`, `productId?` | benefits/summary or benefits/all; filter by productId |
| `mymsd_letters` | `unreadOnly?` | letters, letters/notification |
| `mymsd_letter_download` | `id`, `path?` (default `~/Downloads/MyMSD-letter-<id>.pdf`) | download letters/{id} |
| `mymsd_debt` | — | debt, debt/repayments |
| `mymsd_finance` | `pdfPath?` | bfc (+ bfc/pdf) |
| `mymsd_cards` | `transactions?`, `cardNo?` | cards/summary or cards/all |
| `mymsd_appointments` | `includeLocations?` | appointments (+ appointments/locations) |
| `mymsd_appointment_check` | `reasonIds[]`, `endDate?`, `appointmentId?` | appointments/check, appointments/availability |
| `mymsd_income` | — | income, income/employers |
| `mymsd_employment_plan` | — | employment-plan/activities, traffic-light/rjs-activities, traffic-light/upskilling-activities (each tolerant of NotPermitted) |
| `mymsd_jobs` | — | jobs; adds DES links from session.desUrl |
| `mymsd_one_off_costs` | `types?` (food, dental, schoolUniforms, schoolStationery) | data/oneOffCosts, hardship/data?types= |
| `mymsd_medical_certificate` | — | medicalCertificate |
| `mymsd_housing` | — | housing-register/status, emergency-housing (tolerant) |
| `mymsd_applications` | `referenceNumber?`, `categoryId?`, `partner?` | applications/data, applications/identityVerificationAllowed, genericUpload/check; with ref+category: documentCategory[/partner]/withFiles/…, document[/partner]/uploaded/… |
| `mymsd_address_search` | `query` (≥7 chars) | address/findMatches?line1= |
| `mymsd_job_title_search` | `query` | applications/jobTitles/findMatches?jobTitle= |
| `mymsd_tas` | — | tas/reasonableSteps, tas/data (tolerant), accommodationPayments, tas/otherIncomeProps (tolerant) |

### 4.3 Write tools

| tool | inputs (besides `confirm`) | request |
|---|---|---|
| `mymsd_declare_wages` | `weekStarting` (Monday), `didNotWork?`, `wages[]` {employer, type hourly\|weekly, hours?, hourlyRate?, weeklyTotal?, weeklyHours?}, `childcareCosts?`, `acceptBelowMinimumWage?` | POST income/submitDeclaration — payload built exactly as the SPA's `income/declaration.toJSON` (totalTime/weeklyTime in minutes; "did not work" = one wage of type `empty`) |
| `mymsd_appointment_book` | `reasonIds[]`, `category`, `date`, `locationId`, `notes?`, `appointmentId?` (reschedule), `clientRequirementTypes?` | POST appointments/book (runs appointments/check first; refuses when `mustCall`/`limitReached`) |
| `mymsd_appointment_cancel` | `appointmentId` | DELETE appointments/{id} |
| `mymsd_appointment_callback` | `contactNumber`, `reasonIds[]`, `locationId?`, `requestAppointmentType?` | POST appointments/callbacks |
| `mymsd_contact_update` | any of homeEmail, workEmail, preferredEmail, cellPhone, homePhone, workPhone, fax, preferred | POST client/contacts with the delta against the current client record |
| `mymsd_accommodation_update` | `residentialAddress?` (+ `dateOfMove`, `livingSituation`), `postalAddress?` or `postalSameAsResidential?`, `accommodationCosts?`, `homePhone?` | POST accommodation |
| `mymsd_letters_preference` | `action`: `post` \| `email` (`sendPostalMail`) \| `confirm_email` (`email?`, `emailType?`) | POST client/postal-preferences / client/contacts/confirm-email |
| `mymsd_job_search_activity` | `action` add (activityDate, employerName, role, applicationMethod, applicationMethodDesc?, status) \| set_status (id, status) | POST employment-plan/job-search-activity[/status] |
| `mymsd_rjs_report` | `weekCode`, `comment`, `id?` | POST traffic-light/rjs-activities |
| `mymsd_upskilling_report` | `weekCode`, `courses[]` | POST traffic-light/upskilling-activities (untested) |
| `mymsd_card_set_pin` | `cardNo`, `pin` (4 digits) | Mirrors `cards/controllers/set-pin`: `GET /rest/key/card` (PEM text; strip the 26-char header and 24-char footer → SPKI base64) → RSA-OAEP public key with SHA-1; generate a 256-bit AES-CBC key; ANSI PIN block = XOR of `"0"+len+pin` padded with `F` to 16 hex digits and `"0000"+pan.substring(len-13, len-1)`; encrypt that 16-char hex string (as UTF-8 text) with AES-CBC and a random 16-byte IV; wrap the raw AES key with RSA-OAEP; `POST /rest/cards/set-pin { pan, pinBlock: base64(ciphertext), iv: base64(iv), expiryDate, key: base64(wrappedKey) }`. Node `crypto` covers all of it. Untested on this account (needs a card without a PIN). |
| `mymsd_upload_document` | `files[]` (paths), `evidenceType` (`photoId` \| `otherId` \| `costs`), `businessContext?` (CYC primary/secondary) | Mirrors the profile engine's "Upload a document": per file `POST /rest/hardship/evidence` multipart (`file` + `meta-data` = `{ workType: "GenericUpload", csrfToken }`) → `{ id, isQualityAcceptable }` (unreadable files are reported, not retried); then `POST /rest/genericUpload/data` with the `document` record `{ isOnThePhoneWithMSD: true, files: { <evidenceType>: [fileId…] }, businessContext?, csrfToken }`. Removal is `DELETE /rest/hardship/evidence/{id}`. File rules enforced before sending: JPEG/GIF/PNG/PDF/Word/Excel, 5 MB (512 KB for Word/Excel), ≤ 10 files, encrypted PDFs rejected. |
| `mymsd_hardship_apply` | `types[]` (`food`, `dental`, `schoolUniforms`, `schoolStationery`), `food?` { whatHasHappened: familyEmergency\|urgentBill\|schoolCosts\|medicalCosts\|vehicleCosts\|workCosts\|movingCosts\|other, whatHasHappenedOther?, whyHadToPay, howMuchPaid, howMuchNeed }, `dental?` { whoFor: me\|otherChild, typeOfTreatment: immediateAndEssential\|orthodontic\|other, isPaidForByOther, howMuchNeed }, `schoolUniforms?`/`schoolStationery?` { whoFor, childData, hasAppliedForSYSP, howMuchNeed }, `answers` { chosenCard, hasIncome, hasIncomeChanged, hasAssets, haveAssetsChanged, whyNotAssets: saving\|bills\|other, stepsTaken: [askedRelatives\|lookingForWork\|budgetingPlanning\|reducingCosts\|other\|none], stepsTakenOther?, stepToTake: seekWork\|stopServices\|reduceCosts\|renegotiateDebt\|increaseHours\|setupPayments\|goToMarket\|renegotiateCourtFines\|talkToPowerCompany\|learnToCook\|quitSmoking\|usePublicTransport\|carpool\|consolidateDebt\|talkToSchool\|other, stepToTakeOther?, hasTakenPreviousStep, agreeToRepayments, cantUpload? }, `evidenceFiles?` { dental?: [paths], schoolUniforms?: [paths], schoolStationery?: [paths] }, `suppliers?` [{ name, city, suburb, gstNumber, amount }] | `GET /rest/hardship/data?types=…` first; per-type `eligibility` must be `eligible` (`notEligible`, `mustCall`, `alreadyApplied` are refused with the site's reason); evidence is required for dental/school types unless `cantUpload`: per file `POST /rest/hardship/evidence/{type}` multipart (`meta-data` `{ workType: "hardship", csrfToken }`); then `POST /rest/hardship` with the hardship model serialised exactly as `resources/serializers/hardship` does (adds `count`, `stpCandidate`, `isPrevStepOther`, `types`; `haveAssetsChanged: false` forces `hasAssets: true`; `stepsTaken` codes are sent as the site's display text, `none` alone when chosen). |
| `mymsd_housing_register_checkin` | `passcode?`, four `has…Changed` booleans | POST housing-register/check-passcode → POST housing-register |
| `mymsd_emergency_housing_request` | contactNumber, dateOfNeed, numberOfDependents, region, town | POST emergency-housing (untested) |
| `mymsd_medical_certificate_ready_to_work` | — | POST medicalCertificate |
| `mymsd_application_action` | `action` (accept_obligations, jsp_pre_benefit, accept_by_partner, identity_verification_start, identity_verification_complete, complete_identity, complete_supporting, agree_identity, agree_supporting), `referenceNumber`, `caseReference?`, `payload?` | the matching applications/* or applicationStep/* endpoint. Constants from the bundle: identity category `0001`, supporting-docs category `0021` (context suffix `_C` client / `_P` partner, top level `-1`), steps `IDENTITY_STEP` / `SUPT_DOC_STEP`, upload actions `PROVIDED`, `CANNOTPROVIDE`, `TOTALUPLOAD`, `PARTIALUPLOAD`, `UNABLETOUPLOAD`, `ACCEPTBRING`, `CANNOTNODOCS`, verification types `PASSPORT`, `GOVERNMENT`, `NO_IDENTITY`, `OTHER_ID`. Untested on this account (no current application). |
| `mymsd_tas_submit` | `payload` (object, checked against the TAS model's field list) | POST tas/data (untested) |
| `mymsd_boarders_declaration` | `declarationId`, `form` (object) | POST confirm-boarder-or-renter-declaration (untested) |

Dry-run `effect` strings are written per tool in plain English ("MSD will record a wage declaration for the week
starting Mon 6 Oct 2026: 2 employers, $…").

## 5. Error handling

- `NotLoggedInError` → tool result `isError` with the exact next step (`mymsd_auth import_chrome` / `login`).
- `BotDefenceError` → same, naming the F5 challenge.
- `NotPermittedError` → "not available on this account" (read tools that aggregate several calls report the
  unavailable part and return the rest).
- `MsdError` → `Error: <code>: <message>` plus `data` when present (e.g. `attemptsRemaining`).
- Validation errors from zod surface as the SDK's standard invalid-arguments error.

## 6. Testing

- Offline (`npm test`): cookie jar semantics (domain/path/secure, Set-Cookie attrs, expiry); Chrome cookie decryption
  against a synthetic `Cookies` DB the test encrypts itself (both pre- and post-version-24 layouts); auto-post form
  parsing on captured SAML pages (values redacted); challenge-page detection; wage and hardship payload builders;
  each summariser on redacted fixtures recorded from the live account.
- Live (`npm run smoke`): auth status, every read tool, every write tool as dry run. Never submits.
- Real writes: verified one at a time with the user, starting with reversible ones (letters preference, job-search
  activity, appointment book + cancel).

## 7. Packaging and registration

`package.json` name `mymsd-mcp`, bin `dist/server.js`, scripts `build`/`start`/`test`/`smoke`, engines node ≥ 22.13
(node:sqlite). Register in `~/.claude.json` as `mymsd`: `/opt/homebrew/opt/node@24/bin/node
/Users/test/Downloads/mymsd-mcp/dist/server.js`. README covers: install, first sign-in (`import_chrome` while logged in
in Chrome, or `login`), the Keychain prompt, the `confirm` convention, and the account-specific gaps.

## 8. Out of scope

Account registration / PIN creation (`/rest/public/register/*`, documented in the notes), the DES and MyAccount
sites, and the site's analytics. Nothing is stored beyond cookies and the last session check.
