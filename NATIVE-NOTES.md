# MyMSD (my.msd.govt.nz): native-request notes

Everything discovered about the site's own HTTP API, from the SPA's JavaScript bundles (version
`167.1.7.ded0814755`, 2026-10-12) and from watching a signed-in CloakBrowser session. Each endpoint is
marked **tested** (observed returning 200 in the live session, response shape recorded) or
**from code** (seen in the bundle, not yet called). Response shapes are key/type skeletons; no account
values are recorded here.

Bundles read: `/assets/my-msd-*.js` (host app), `/assets/vendor-*.js` (contains the shared `resources`
addon — adapters, models, serializers, `ajax` util — and the `login` engine), and the 20 lazy engines
listed in the `my-msd/config/asset-manifest` meta tag of `index.html` (`/engines-dist/<engine>/assets/engine-*.js`).

## 1. Architecture

- Ember app (ember-engines) at `https://my.msd.govt.nz/`. All data goes through `https://my.msd.govt.nz/rest/...`
  (Ember Data RESTAdapter with `namespace: "rest"`) plus a few non-`/rest` auth URLs.
- Engines mounted under the authenticated route: `apply`, `appointments`, `benefit-reapp` (`/benefit-reapplication`),
  `benefits`, `cards`, `current-applications` (`/applications`), `debt`, `finance`, `find-a-job`, `hardship`, `housing`,
  `housing-register`, `income`, `letters`, `medical-certificate`, `my-eligibility`, `profile`, `something-changed`,
  `temporary-additional-support`, `traffic-light`; `login` is mounted at `/`.
- Two external systems are linked, not proxied: **MyAccount** (`https://services.workandincome.govt.nz/eos/mymsd`,
  params `sso=true&callingapp=MyMSD&landingpage={{dest}}`) and **DES / "new MyMSD"**
  (`https://new.my.msd.govt.nz`, params `callingapp=myMSD&landingpage={{desDest}}`; pages `en/job/link?action=profile|jobMatch|jobSearch|jobDetail&id=`).
  Both URLs come back in `GET /rest/session` (`myAccountBaseUrl`, `desUrl`).
- Feature flags come from two places: the static `featureFlags` block in `index.html`'s config meta tag and the
  per-client `features` object in `GET /rest/client` (the latter wins: `clientData._configureFeatures`).

## 2. Transport conventions (`resources/utils/ajax`)

- Same-origin `fetch`, `mode: "same-origin"`, header `X-Requested-With: XMLHttpRequest`, default
  `Content-Type: application/json; charset=utf-8` (not sent for multipart uploads).
- `GET` params go in the query string (empty values dropped). `POST` bodies are JSON; **every POST body gets
  `csrfToken` injected** (`_addCSRFToData`) — the token is `csrfToken` from `GET /rest/session`. Ember Data saves do
  the same through the serializers (`application` serializer adds `e.csrfToken = session.csrfToken`).
- Uploads: `multipart/form-data`; field `file` (single) or `file1..fileN` (multiple), plus a `meta-data` field holding
  JSON (with `csrfToken` inside) — or, without metadata, `csrfToken` as its own form field. Upload timeout 120 s
  (`time-out` header is only read client-side).
- Timeouts 60 s, retries: 2 × 2 s on network errors. 204 → null; `text/*` → text; `*/json` → JSON; else blob.
- Error envelope: `{ "error": { "code": string, "message": string, "data": any|null } }`. Codes
  (`resources/constants/error-codes`): `unauthenticated` (401), `unauthorized`, `bad_request`, `client_secure`, `data_quality`,
  `expired_token`, `forbidden`, `invalid_data`, `locked_out`, `network_error`, `server_busy`, `server_error` (5xx),
  `service_down` (503), `tas_error`, `not_found`, `waf` (403 with response header `x-msd-supportid`).
  Engine-specific codes seen: `invalid_credentials` (`data.attemptsRemaining`, `data.lockOutLength` seconds),
  `has_realme_login`, `invalid_code`, `expired_code`, `sms_limit_exceeded`, `no_token`, `unknown_phone_email`,
  `cancel_appointment_failed`, `throttle_exceeded`, `page_limit_exceeded`. A 555 status with the normal error envelope
  was also observed (`/rest/data/outcomes`).
- Unauthenticated `/rest/*` calls return the login SPA HTML (`text/html`, HTTP 403) rather than JSON — e.g.
  `/rest/emergency-housing` and `/rest/employment-plan/job-search-activity` did this even while signed in, which
  means "not permitted for this client", not "logged out".

## 3. Bot defence (F5 "TSPD") — why a bare HTTP client cannot start cold

- A cookieless request to **any** URL, including `/rest/session`, gets HTTP 200 `text/html`: the F5 JavaScript
  challenge page (`window["bobcmn"]…`, loader `/TSPD/?type=18`, `/TSPD/?type=21`), plus short-lived `TS4a38d0e9029`,
  `TS4a38d0e9078` (Max-Age 30) and `TSeae47ed5027` cookies. The challenge must run in a real browser; it then issues
  `TSPD_101_DID`, `TS00000000076`, `TSeae47ed5027` and the httpOnly `TS01188ea2`.
- **Tested:** once the browser holds those cookies, a plain Node request with the same cookie jar
  (Playwright `APIRequestContext`, no page) gets `200 application/json` from `/rest/session` — with or without
  `X-Requested-With`. So: let CloakBrowser establish the session, export the jar, run the API with Node `fetch`
  (keep a cookie jar — `TSeae47ed5027` is re-set on responses).
- CloakBrowser profile used: `~/.cloakbrowser-profiles/claude` (cookies synced from Chrome's Default profile by
  `~/Downloads/cloakbrowser-chrome-sync/start.sh`).

## 4. Cookies and session lifetime

| cookie | domain | lifetime | role |
|---|---|---|---|
| `JSESSIONID` | my.msd.govt.nz | Max-Age 7500 s (~2 h), Secure, HttpOnly, SameSite=None | server session |
| `TS01188ea2` | my.msd.govt.nz | session, HttpOnly | F5 session |
| `TSeae47ed5027`, `TS00000000076`, `TSPD_101_DID` | my.msd.govt.nz | session | F5 bot-defence tokens (also mirrored into localStorage `TS00000000076`, `TSPD_74`) |
| `verifiedDeviceCookie` | my.msd.govt.nz | 1 year, HttpOnly | device verification passed (skips the SMS/email code step) |
| `longLivedCookie` | my.msd.govt.nz | ~25 days, HttpOnly | "remember me" (PIN-only login, preferred login method) |
| `x-ms-cpim-sso:msdciam.onmicrosoft.com_0`, `x-ms-cpim-geo` | identity.msd.govt.nz | session | Azure AD B2C SSO at MSD's IdP |
| `x-ms-cpim-sso:b2cdiaprdrmpubdir…`, `x-ms-cpim-cache…`, `x-ms-cpim-csrf`, `x-ms-cpim-trans` | .login.realme.govt.nz | session | RealMe (also Azure B2C) SSO |
| `_ga*`, `_gid` | .msd.govt.nz | — | analytics |

- Idle timeout: `GET /rest/session` returns `timeout: 900` (seconds). The SPA subtracts 5 s, counts down in a worker,
  warns at 60 s left, and keeps the session alive by calling `GET /rest/session` again (`keepalive` action). After
  expiry it navigates to the logout URL with `reason=timeout`.
- `GET /rest/session` also returns `ssoUrl`; when non-null the SPA loads it in a hidden iframe to extend the IdP session.

## 5. Authentication flows

### 5.1 Session state — `GET /rest/session` (tested)

```
{ isAuthenticated: bool, verifiedDevice: bool, ssoEnabled: bool, timeout: number (s),
  preferredLoginMethod: "realme"|"pin"|"", firstName, clientNumber (9 digits), csrfToken (30 chars),
  forcedLogout: bool, lastLogin: "YYYY-MM-DD HH:mm", serverDateTime: "YYYY-MM-DD HH:mm:ss", guid (uuid),
  modal: null|…, versionNumber, hardshipBusinessHoursWarning: bool, myAccountBaseUrl, myAccountBaseParameters,
  ssoUrl: null|string, desUrl, desBaseParams, banner? }
```
Called by the app on every load and as keep-alive. Expected (not yet observed) when logged out: 200 with
`isAuthenticated: false`.

### 5.2 RealMe sign-in through MSD's Azure B2C (the flow this account uses; observed end to end)

1. `GET /idpsaml/ciamsession?intendedUrl=%252Fdashboard` (the SPA double-encodes the path) →
   `{ "redirectUrl": "/saml2/authenticate/ciam?allowCreate=true&token=welcome_dashboard" }` (tested).
   Constants (`resources/constants/saml-urls`): check `/idpsaml/ciamsession`, realme `/idpsaml/ciamSSO`,
   logout `/idpsaml/saml/manual-slo`. The config's `ssoReturnURL` is `/idpsaml/authenticate`.
2. `GET /saml2/authenticate/ciam?allowCreate=true&token=…` → 200 HTML: Spring SAML auto-submitting form
   (`SAMLRequest`) to
   `https://identity.msd.govt.nz/msdciam.onmicrosoft.com/B2C_1A_MSD_CIAM_MyMSDSignUpOrSignin/samlp/sso/login`.
   Sets a fresh `JSESSIONID`.
3. The B2C IdP, holding a valid `x-ms-cpim-sso` cookie, answers with an auto-posted `SAMLResponse` without any UI
   (no RealMe screen appeared). Without that cookie it shows the RealMe login (`login.realme.govt.nz`).
4. `POST /session/login/samlResponse` (form `SAMLResponse`) → 302
   `/realme/callback?from=null&status=success&rememberMe=true&intendedUrl=/dashboard`.
5. The SPA route `realme-callback` reads `status` and calls `GET /rest/session`. Failure statuses:
   `realme_unknown_user`, `realme_unknown_principal`, `realme_link_failed`, `realme_general`, `realme_timeout`.
- Direct RealMe redirect helper (`resources/utils/redirect-to-realme`):
  `/saml2/authenticate/realme?from=<state>&allowCreate=<bool>&token=<token>&rememberMe=<bool>&realme=realme`.

### 5.2a What the silent flow does without an IdP session (tested 2026-10-12, server build)

- `GET /idpsaml/ciamsession` → `/saml2/authenticate/ciam` is a **passive** SAML check: B2C answers at once with a
  SAML error response (page title "Logging in...", auto-post form to `/session/login/samlResponse`), and MyMSD's
  callback comes back as `/realme/callback?status=failure&intendedUrl=/dashboard&rememberMe=false`. No UI is ever
  offered on this path.
- The interactive entry `/saml2/authenticate/realme?from=login&allowCreate=false&token=&rememberMe=true&realme=realme`
  posts to B2C, which 302s to RealMe's own B2C
  (`login.realme.govt.nz/b2cdiaprdrmpubdir.onmicrosoft.com/B2C_1A_DIA_RealMe_LoginService/samlp/sso/login?SAMLRequest=…`);
  that page is a JavaScript-only login UI ("We can't sign you in. Your browser is currently set to block JavaScript")
  and RealMe's own SSO cookies did not sign in without it. A person is needed from here.
- B2C's `x-ms-cpim-sso:msdciam.onmicrosoft.com_0` is rotated when it is used: a copy taken from Chrome after another
  client (the cloakbrowser profile) had used it was rejected, and B2C's error response cleared it from the jar.
- The SPA's own idle timeout (`doLogout("timeout", true)`) navigates to `/idpsaml/saml/manual-slo?reason=timeout`,
  a SAML single logout that ends the B2C session for every client. A MyMSD tab left open in any browser therefore
  kills silent re-login for the MCP too.

### 5.3 Client-number + PIN sign-in (from code)

- `POST /session/login/pin` body `{ clientNumber, dateOfBirth: "YYYY-MM-DD", pin (4 digits), rememberMe: "true"|"false" }`
  — or just `{ pin, rememberMe: "true" }` when `longLivedCookie` remembers the client. Response may contain
  `redirectUrl` (e.g. `/login/verify-device`). The app then calls `GET /rest/session` and treats
  `isAuthenticated: false` as failure. Before showing the login page the app calls `POST /rest/session/clear`.
- Device verification (`login/services/verify-device`), when `verifiedDevice` is false:
  `POST /rest/logon/verifydevice/send-code` `{ verifyUsing: ""|"phone"|"email", token, rememberDevice }` →
  `{ verificationSentTo: "phone"|"email", token, clientDetails: { firstName, lastName, maskedPhone, maskedEmail, dateOfBirth } }`
  (first call with empty `verifyUsing` and empty token); `POST /rest/logon/verifydevice/verify-code`
  `{ code (6 digits), token, rememberDevice }` → optional `{ redirectUrl }`. Max 4 code sends.
- Registration (`my-msd/services/registration`, public): `POST /rest/public/register/verify-dob` `{ clientNumber, dateOfBirth }`
  → `{ clientDetails: {…}, token, … }`; `POST /rest/public/register/send-code` `{ verifyUsing, token }` → `{ verificationSentTo }`;
  `POST /rest/public/register/verify-code` `{ code, token, rememberDevice }`; `POST /rest/public/register/create-pin` `{ pin, token }`.
- `POST /rest/session/forget-me` (forget the remembered client entirely), `POST /rest/session/forget-remember-me`
  (forget preferred login method only). `GET /rest/sso-session` → `{ timeRemaining: ms|null, returnToUrl: string|null }`
  (tested; pending SSO hand-off back to MyAccount/DES).
- Logout = full navigation to `/idpsaml/saml/manual-slo?reason=<user|timeout|forced>`. It is a SAML single-logout and
  ends the B2C SSO session too, so an automated client should **not** call it if it wants silent re-login later.

## 6. REST endpoint catalogue

Ember Data defaults: `GET /rest/<path>` for `findAll`/`query`, `GET /rest/<path>/<id>` for `findRecord`,
`POST /rest/<path>` for `createRecord`, `DELETE /rest/<path>/<id>` for `destroyRecord`; `<path>` is the camelized,
pluralized model name unless an adapter overrides `pathForType` (overrides are listed per endpoint below).
Responses are RESTSerializer-style: a root key named after the model (`letters`, `cards`, `appointments`, …).

### 6.1 Dashboard / client

| method & path | notes |
|---|---|
| `GET /rest/client` | **tested.** `{ clientNumber, firstName, lastName, middleNames, flags{…30 booleans: mustCallForAppointment, mustCallForBenefitReapp, hasValidBenefits, hasMainBenefit, hasAccommodationSupplement, hasWorkingBenefit, hasAgent, isPartner, isStaff, hasIndividualEmploymentPlanActivities, isEligibleForChildcareApplication, isEligibleForSuperApplication, hasYPP, is65Plus, is64ThreeQuarterPlus, isMoneyManaged, isTrespass, needsToConfirmEmail, hasCurrentApplication, needsToConfirmPostalPreference, registeredVerifyingEmail, clientPrefersPostMail, showRelationships, isSkinny, isWFCMAssigned, partnerNeedsToTakeAction, isCSO, hasCweTlsBannerFlag, isEligibleForWorkingAgeApplication, isAllowedChildcareExemption}, features{…55 booleans}, contactDetails{ csrfToken, homePhone, workPhone, cellPhone{countryCode, areaCode, number}, fax, homeEmail, workEmail, preferred ("cellPhone"…), preferredEmail ("homeEmail"…), preferredEmailAddress }, residentialAddress{ id, addressText, line1, line2, suburb, city, country, postalCode, dateOfMove }, postalAddress, communityServicesCard{ issuedTo, cardNumber, validFrom, expiry, isComboCard }, clientType (e.g. "GCMC"), partner, children[], livingSituation, trafficLightStatus ("GREEN"…), failureLevel, mmStartDate, mmEndDate, mmEventType, mmOutcomeCode, cweStartDate, cweEndDate, cweEventType, cweOutcomeCode }`. Serializer renames `contactDetails`→`contactInfo`, id = clientNumber. |
| `GET /rest/benefits/summary` | **tested.** `{ benefits: [{ status, type, name, productId, bankPaymentAmount, nextPaymentDate, cardPaymentAmount, nextPaymentTotal, details: null }] }` (adapter `benefit-summary`). |
| `GET /rest/benefits/all` | **tested.** Same rows with `details: { benefitDetails: { paymentFrequency, ongoingPaymentDate, lineItems: [{ name, amount, details }] }, debtRepayments: { lineItems: [...] }, total }` (adapter `benefit` → `benefits/all`). SPA routes `/benefits/:product_id`, `/benefits/:product_id/:secondary_index`. |
| `GET /rest/tiles` | **tested.** `{ tiles: [{ id, featureFlag }] }` — dashboard tiles. |
| `GET /rest/banners` | **tested.** `{ banners: [{ type, title, subTitle, text, url, urlTitle, level }] }`. |
| `GET /rest/notifications` | **tested.** `{ notifications: [{ id, title, dueBy, benefitType, isGeneratedId, outcome{…} }], unavailableNotificationTypes: [] }` ("To do" list). `DELETE /rest/notifications/<id>` is used after a profile-type outcome is actioned (from code). |
| `GET /rest/jobs` | **tested.** `{ jobs: [{ id, jobTitle, jobType ("FULLTIME"…), employmentConditions, minRateOfPay, maxRateOfPay, rateOfPayFrequency, displayPayonListing, jobSuburb, jobDistrict, workplaceArrangement }] }` ("Latest jobs"; detail opens DES `jobDetail&id=`). |
| `GET /rest/letters/notification` | **tested.** `{ newLetters: number }`. |
| `GET /rest/cyc-status` | **tested.** `{ cycStatus: { isApplicationComplete } }` (CYC = check-your-circumstances). |
| `GET /rest/engagement-status` | **tested** (body `null` for this account). Model: `{ isApplicationComplete, isAppointmentNeeded, isPartnerRCU, isPartnerTREP, showBookLink }`. |
| `GET /rest/cards/summary` | **tested.** see 6.5. |

### 6.2 Letters

| method & path | notes |
|---|---|
| `GET /rest/letters` | **tested.** `{ letters: [{ id: number, date, type, size (bytes), hasRead }], hasMore: bool }`. Max 200 (`maxNumLetters`); a `lettersThrottleReached` key in place of the list means throttled. |
| `GET /rest/letters/<id>` | PDF download (template: `href="/rest/letters/{id}"`, `download="{id}.pdf"`, target `_blank`). From code. Whether this marks the letter read server-side is not verified (the SPA sets `hasRead` locally on click). |
| `POST /rest/client/postal-preferences` | `{ sendPostalMail: bool, … }` → updated contact info object (from code; `resources/utils/postal-preferences`). |
| `POST /rest/client/contacts/confirm-email` | `{ viewedConfirmEmailPrompt: true, emailAddress? (confirm or replace the email), noEmailAddress?: true (no email), emailType?: "homeEmail" \| "workEmail" }` (from `my-msd/components/modals/letters/confirm-email`). |

### 6.3 Debt and finance

| method & path | notes |
|---|---|
| `GET /rest/debt` | **tested.** `{ total, debt: [{ isPreviousDebt, type, description, dateEstablished, originalAmount, repaidAmount, owingAmount }] }`. |
| `GET /rest/debt/repayments` | **tested.** `{ openingBalance, openingBalanceDate, totalRepayments, totalRemaining, historyFromDate, historyToDate, repayments: [{ description, date, amount }] }`. |
| `GET /rest/bfc` | **tested.** Financial summary ("My financial information"): `{ fromDate, myDetails{ fields{ name, clientNumber } }, family{ lineItems[{type,value}] }, weeklyPayments{ lineItems, meta{ total, additionalNotes[] } }, fortnightlyPayments, childcareAssistances[], wages, otherIncomeAfterTax, otherIncomeBeforeTax, accommodationCosts, disabilityAllowances[], tas, specialBenefitCosts, debtsWithUs{ lineItems[{ type, originalAmount, balanceOwing, repaymentRate, isTrace }] }, otherDebts, childDisabilityAllowance{ lineItems, meta } }` (values are preformatted strings). |
| `GET /rest/bfc/pdf?_=<timestamp>` | PDF of the above (from code). |

### 6.4 Profile, contact details, address, accommodation

| method & path | notes |
|---|---|
| `POST /rest/client/contacts` | Delta of the contact-info model: any of `preferred`, `preferredEmail`, `homeEmail`, `workEmail`, `homePhone`, `workPhone`, `cellPhone`, `fax` (phones as `{ countryCode, areaCode, number }`) → returns the updated contact details (from code, `updater.submitContactInfoChanges`). |
| `POST /rest/accommodation` | `{ residentialAddress?{ line1, line2, suburb, city, country, postalCode, dateOfMove, addressText }, livingSituation?{ hasOtherPeopleAtAddress, numOtherPeopleAtAddress, numPeoplePayingBoard, numPaymentBoard }, homePhone?, postalAddress: {…} | { isSameAsResidential: true }, accommodationCosts?: `accommodation-cost.serialize({delta: true})` = `{ dateStopped }` or `{ rent | board | ownHouse: { landlordName?, landlordPhone?{countryCode, areaCode, number}, isHousingNZ? (rent only; hasWaterRates is never serialised), dateChanged, costs: [ { type, amount, frequency, actualPaying } (rent/board) | { type, amount, frequency, payee, dateChanged, dateStopped, isEdited, isNew, hasStopped } (ownHouse) ] } }` — cost types from `resources/constants/accommodation-costs` (`rent`, `rentSh`, `board`, `mortgage`, `mortgage1`, `houseInsurance`, `rates`, `mortgageInsurance`, `groundLease`, `waterRates`, `bodyCorpFees`, `regionalCouncilRates`, `essentialRepairs`, `other`), frequencies from `payment-periods`; the rent serializer drops costs without an amount }` (from code; "Nothing changed" is rejected client-side). |
| `GET /rest/address/findMatches?line1=<text>` | **tested.** Returns a bare array `[{ id, addressText, line1, line2, suburb, city, country, postalCode, dateOfMove }]` (min 7 chars, throttled 300 ms client-side). |
| `GET /rest/genericUpload/check` | **tested.** `{ canUpload: bool }` — whether "Upload a document" is available. |
| `POST /rest/hardship/evidence` (generic upload step) | "Upload a document" (`profile/controllers/upload-document/upload-evidence`) reuses the hardship evidence endpoint through `resources/components/input/multi-file-upload`: one multipart POST per file (`file` + `meta-data` = `{ "workType": "GenericUpload", "csrfToken": … }`) → `{ id, isQualityAcceptable, … }`; replacing a file posts to `/rest/hardship/evidence/<fileId>`; `DELETE /rest/hardship/evidence/<fileId>` removes one. Evidence types offered: `photoId`, `otherId`, `costs` (CYC uploads: `costs` only). From code. |
| `POST /rest/genericUpload/data` | the `document` record saved after the uploads (from code): `{ isOnThePhoneWithMSD: true, files: { <evidenceType>: [fileId…] }, businessContext? ("primary"/"secondary" for CYC uploads), applicationReferenceNum?, hasGenericUpload?, whatStep?, uploadAction?, caseReference?, applicationIdentity?, csrfToken }`. Inside an application the same record goes to `/rest/applicationStep/agreeIdentity` or `/rest/applicationStep/agreeSupporting`. |
| `GET /rest/medicalCertificate` | **tested.** `{ showMedicalCertificate, expiryDate, mustContactUs, showExpiringBanner, showExpiredBanner, isReadyToWork, isHighPriority, isRenewable, hasJobseekerProfile? }`. |
| `POST /rest/medicalCertificate` | "I'm ready to work" declaration; sent with no body (from code). |

### 6.5 Payment cards

| method & path | notes |
|---|---|
| `GET /rest/cards/summary` | **tested.** `{ cards: [{ cardNo (8), pan (16), status ("ACTIVE"), isBlocked, balance, valueDate, transactions: [], subAccounts: [], hasNewPayment, expiryDate, isPinSet, pinSetDate, hasPinAttemptsBeenExceeded }], hasCards }`. |
| `GET /rest/cards/all` | **tested.** Same, with `transactions: [{ description, amount, date }]` (adapter `card-detail`). `GET /rest/cards/all/<card_detail_id>` for one (from code). |
| `GET /rest/key/card` | RSA public key as text; imported with SHA-1 for `wrapKey` (from code, `cards/services/pin-encryption`). |
| `POST /rest/cards/set-pin` | `{ pan, pinBlock, expiryDate, key, iv }` (from `cards/controllers/set-pin` + `resources/utils/encryption`): the PEM from `/rest/key/card` is cut to its base64 body (`substring(26, length-24)`) and imported as SPKI RSA-OAEP with **SHA-1**; a 256-bit AES-CBC key is generated; ANSI PIN block = XOR of `"0"+len+pin` right-padded with `F` to 16 hex digits and `"0000"+pan.substring(len-13, len-1)`, result upper-case 16 hex digits; that string is encrypted as UTF-8 with AES-CBC and a random 16-byte IV → `pinBlock` (base64 ciphertext) + `iv` (base64); `key` = base64 of the raw AES key wrapped with RSA-OAEP. Response fields are merged into the card record. From code. |

### 6.6 Appointments

| method & path | notes |
|---|---|
| `GET /rest/appointments` | **tested.** `{ appointments: [{ id, date, endDate, type, category ("FACETOFACE"\|"PHONE"\|"SEMINAR"), topic, personMeeting, isCancellable, isReschedulable, hasRescheduled, display20WorkingDaysRule, location{…}, reasons[{ id, dueBy… }], status }] }`. |
| `GET /rest/appointments/locations` | **tested.** `{ locations: [{ id (e.g. "ASMR"), name, address: [], directions }] }`. |
| `GET /rest/appointments/check?reasonIds=a,b` | **tested.** `{ mustCall, limitReached, existing, isSeminarAvailable, isPhoneAvailable, isInPersonAvailable, topic, appointmentHeaderDetails, appointmentFooterDetails }` — run before booking. |
| `GET /rest/appointments/availability?reasonIds=a,b&endDate=YYYY-MM-DD` | **tested.** `{ todaysDate, cycExpiryDate, categorisedAppointments: [{ category, availability: [...] }], location{ id, name, address, directions } }`. Reschedule variant: `?appointmentId=<id>`. |
| `GET /rest/appointments/check-datetime?appointmentId=<id>` | `{ isPastStartTime }` (from code). |
| `POST /rest/appointments/book` | `{ category, clientRequirementTypes[], date, appointmentId? (reschedule), locationId, notes, reasonIds[], csrfToken }` → the created appointment (from code; serializer flattens into the root). |
| `DELETE /rest/appointments/<id>` | cancel (`destroyRecord`; error code `cancel_appointment_failed`). From code. |
| `GET` / `POST /rest/appointments/callbacks` | `{ contactNumber, locationId, reasonIds, requestAppointmentType }` — request a phone call-back (benefit reapplication). From code. |

Other enums from `resources/constants/*`: hardship types `food`, `dental`, `schoolUniforms`, `schoolStationery` (evidence and repayment types: the last three); eligibility `eligible`, `notEligible`, `mustCall`, `alreadyApplied`; whatHasHappened `familyEmergency`, `urgentBill`, `schoolCosts`, `medicalCosts`, `vehicleCosts`, `workCosts`, `movingCosts`, `other`; stepsTaken `askedRelatives`, `lookingForWork`, `budgetingPlanning`, `reducingCosts`, `other`, `none`; stepsToTake `seekWork`, `stopServices`, `reduceCosts`, `renegotiateDebt`, `increaseHours`, `setupPayments`, `goToMarket`, `renegotiateCourtFines`, `talkToPowerCompany`, `learnToCook`, `quitSmoking`, `usePublicTransport`, `carpool`, `consolidateDebt`, `talkToSchool`, `other`; whyNotAssets `saving`, `bills`, `other`; whoFor `me`, `otherChild`; dental treatment `immediateAndEssential`, `orthodontic`, `other`; accommodation cost types `rent`, `board`, `ownHouse`, `emergencyOrTransitional`; frequencies `weekly`, `fortnightly`, `fourWeekly`, `monthly`, `twoMonthly`, `quarterly`, `fourMonthly`, `sixMonthly`, `annually`; client types `general`, `rcu`, `super`, `youth`, `staff`, `ltcm`; appointment statuses `attended`, `unattended`, `unknown`; traffic light `GREEN`, `ORANGE`, `RED`, `NOT APPLICABLE`; upload work types `tas`, `hardship`, `GenericUpload`; upload actions `PROVIDED`, `CANNOTPROVIDE`, `TOTALUPLOAD`, `PARTIALUPLOAD`, `UNABLETOUPLOAD`, `ACCEPTBRING`, `CANNOTNODOCS`; verification types `PASSPORT`, `GOVERNMENT`, `NO_IDENTITY`, `OTHER_ID`; document steps `IDENTITY_STEP`, `SUPT_DOC_STEP`; identity category `0001`, supporting docs `0021` (+ `_C`/`_P` context suffix, top level `-1`). File rules: JPEG/GIF/PNG/PDF/Word/Excel, 5 MB global, 512 KB for Word/Excel, filename shown truncated at 20 chars.

Appointment reason ids (`resources/constants/appointment-reasons`): `changeChildren`, `changePartner`, `changeAddress`,
`oneOffCost`, `houseRepairs`, `benefitReapp`, `benefitReappFaceToFace`, `newBusinessAccommodationSupplement`,
`newBusinessAccommodationSupplement65Plus`, `obligationFailure`, `workForYou`, `workForYouReapp`, `newBusinessWorkingAge`,
`newBusinessSuper`, `newBusinessSuperExpress`, `hardshipNoCard`, `hardshipApplicationInProgress`,
`temporaryAdditionalSupport`, `tas`, `applyUcbOb`, `cyc`. Outcome types: `appointment`, `appointmentPhone`,
`appointmentImmediate`, `appointmentSeminar`, `dropOff`, `contactUs`, `hardship`, `simple`, `myAccount`, `profile`, `food`.

### 6.7 Income / declare wages

| method & path | notes |
|---|---|
| `GET /rest/income` | **tested.** `{ fromDate, total, lastDeclarationAmount, frequency, productId, displaySummary, incomeDetails: [], declareWagesStartDate }`. `?excludeFutureIncome=true` accepted. |
| `GET /rest/income/employers` | **tested.** `{ employers: [{ name }] }` — past employers pre-filled into a declaration. |
| `POST /rest/income/submitDeclaration` | `{ date: "YYYY-MM-DD" (Monday of the ISO week), isEdit: false, childcareCosts, wages: [{ employer, totalTime (minutes), totalIncome, type: "hourly"\|"weekly"\|"empty"\|"", isDaily, hourlyRate, weeklyTotal, weeklyTime }], isAcceptedUnderMinWage, csrfToken }` (`income/declaration.toJSON`; "did not work" = one wage of type `empty`). Limits: ≤10 wages, total ≤ 5000, weekly time ≤ 7200 min, childcare ≤ 9999.99, training wage 19.16/h. From code. |

### 6.8 Employment plan, obligations, job search ("traffic light")

| method & path | notes |
|---|---|
| `GET /rest/employment-plan/activities` | **tested.** `{ activities: [{ id, dueBy, description }], hasRecordJobSearch, jobSearchActivities: [] }`. |
| `GET /rest/employment-plan/job-search-activity` | 403 (login HTML) for this account — only for clients with that obligation. |
| `POST /rest/employment-plan/job-search-activity` | `{ activityDate, employerName, role, applicationMethod, applicationMethodDesc, status, csrfToken }` → `{ jobSearchActivities… }` (from code). |
| `POST /rest/employment-plan/job-search-activity/status` | `{ id, status }` (from code). |
| `GET /rest/traffic-light/rjs-activities` | **tested.** `{ id, reportJobSearchActivities: [{ weekCode, startDate, endDate, activityCount }] }`. |
| `POST /rest/traffic-light/rjs-activities` | `{ id, weekCode, comment, csrfToken }` (from code). |
| `GET /rest/traffic-light/upskilling-activities` | **tested.** `{ upskillingActivities: [{ weekCode, startDate, endDate, courses }] }`. |
| `POST /rest/traffic-light/upskilling-activities` | serialized upskilling activity (from code). |
| `GET /rest/applications/jobTitles/findMatches?jobTitle=<text>` | **tested.** bare `string[]`. |
| `GET /rest/course/<courseId>` | course-detail model `{ courseId, title, shortDescription, longDescription, providerId, providerName, providerEmailId }` (from code; bare `/rest/course` is 404). |

### 6.9 One-off costs / hardship ("Something has changed")

| method & path | notes |
|---|---|
| `GET /rest/data/oneOffCosts` | **tested.** `{ oneOffCosts: [{ category, isMore, title, outcome{ id, type, clientRequirementGroups[], appointmentReasons, description, additionalDetails, dueBy, keyword, isOneOffCostReason, isHiddenReason, hardshipType, appointmentReasonId, isSensitive, buttonText, expiryDate, isRenewable, mustContactUs, productType, applicationType } }] }` (53 rows). |
| `GET /rest/data/outcomes` | returned HTTP 555 with the error envelope for this account. |
| `GET /rest/hardship/data?types=food,dental,schoolUniforms,schoolStationery` | **tested.** `{ isStpCandidate, count, totalAssets, food{ sixMonthFoodAllowance, onlineThreshold, maxAmount, balance, eligibility }, dental, schoolUniforms, schoolStationery, lastApplication, partnerIncome, partnerAssets }`. |
| `POST /rest/hardship` | what `resources/serializers/hardship.serialize` sends (model attributes transformed): `{ count, stpCandidate, isPrevStepOther, chosenCard, hasIncome, hasIncomeChanged, hasAssets (forced true when haveAssetsChanged is false), haveAssetsChanged, whyNotAssets: <display text>, isWhyNotAssetsOther, stepsTaken: [<display texts>, stepsTakenOther text], stepsTakenNone, stepToTake: <code>, stepToTakeOther, isStepToTakeOther, hasTakenPreviousStep, agreeToRepayments, cantUpload, types: [ { type: food|dental|schoolUniforms|schoolStationery, …that type's fields (food: whatHasHappened, whatHasHappenedOther, whyHadToPay, howMuchPaid, howMuchNeed, sngAmount, balance, sixMonthFoodAllowance, maxAmount, eligibility; dental: whoFor, typeOfTreatment, isPaidForByOther, howMuchNeed, maxAmount, sngAmount, …; school: whoFor, childData, hasAppliedForSYSP, howMuchNeed, …), suppliers[{ name, city, suburb, gstNumber, amount }] } ] }` — the top-level `food`/`dental`/`schoolStationery`/`schoolUniform` keys and `stepsTakenOther` are deleted; there is no evidence key (uploads are linked by their metadata). From code. |
| `POST /rest/hardship/evidence/<typeId>` | multipart upload (`file` + `meta-data`), response `{ id, isQualityAcceptable, … }`; `DELETE /rest/hardship/evidence/<fileId>`. From code. |
| `GET /rest/accommodationPayments` | **tested.** `{ accommodationPayments: [] }`; `POST /rest/accommodationPayments` creates one (TAS flow). |

### 6.10 Housing

| method & path | notes |
|---|---|
| `GET /rest/housing-register/status` | **tested.** `{ alreadyCheckedIn }`. |
| `POST /rest/housing-register/check-passcode` | `{ passcode }` (from code). |
| `POST /rest/housing-register` | `{ hasRelationshipChanged, hasChildrenChanged, hasIncomeChanged, hasLivingSituationOrLodgingCostsChanged, csrfToken }` — Housing Register check-in (from code; client-generated uuid id is stripped). |
| `POST /rest/emergency-housing` | `{ contactNumber{…}, dateOfNeed, numberOfDependents, region, town }` (from code; GET gave 403 HTML for this account). |
| `POST /rest/confirm-boarder-or-renter-declaration` | form from `/confirm-boarders-or-renters/:declaration_id` (from code; fields not extracted). |

### 6.11 Applications (benefit applications, identity, documents)

| method & path | notes |
|---|---|
| `GET /rest/applications/data` | **tested.** `{ restrictNextSteps, isFirstContactRecent, workingAgeApplication, workingAgeAppointment, work4uAppointment, isActiveClient, isComplicated, currentApplicationAppointmentReason, superApplication, superAppointment }` — `application/detail` objects carry `referenceNumber, date, isExpiring, obligations, …, categories, partnersCategories, show*/is*Complete/…ButtonAction` flags. |
| `GET /rest/applications/getApplicationAttachment/<id>` | PDF of a submitted application (from code). |
| `POST /rest/applications/acceptObligations`, `POST /rest/applications/jspPreBenefit`, `POST /rest/applications/acceptByPartner` | application steps (from code). |
| `GET /rest/applications/identityVerificationAllowed` | **tested.** `{ isAllowed }`. |
| `GET /rest/applications/identityVerificationRequest?context=…` | `{ authUri }` → browser redirect for passport / driver-licence verification; `POST /rest/applications/identityVerificationResponse` stores the result (from code). |
| `GET /rest/documentCategory/withFiles/<applicationReferenceNumber>/<categoryId>` (partner: `documentCategory/partner/withFiles/…`) | document categories with file counts (from code). |
| `GET /rest/document/uploaded/<ref>/<categoryId>` (partner: `document/partner/uploaded/…`) | previously uploaded file names (from code). |
| `POST /rest/document/uploadIdentity`, `POST /rest/document/uploadSupporting` | multipart with `meta-data` `{ context, category: <category name>, parentCategory: <cmsCode>, subCategory: <categoryId>, workType: "GenericUpload", applicationReference, csrfToken }` (`sub-type.uploadMetadata`); `DELETE /rest/document/evidence/<id>` (from code). |
| `POST /rest/applicationStep/completeIdentity`, `POST /rest/applicationStep/completeSupporting` | `{ document: { applicationReferenceNum, caseReference, uploadAction, applicationIdentity?{ isVerified, verificationType } } }`; `POST /rest/applicationStep/agreeIdentity` / `agreeSupporting` are the `document` create paths in those steps (from code). |

Upload rules (`resources/services/file-drop`): MIME whitelist from `resources/constants/file-params` (PDF only when
`allowPDFUpload`), `.rtf` rejected, global and per-MIME size limits, encrypted PDFs rejected, up to 10 evidence files,
server replies with `isQualityAcceptable` (OCR check).

### 6.12 Temporary Additional Support (TAS)

| method & path | notes |
|---|---|
| `GET /rest/tas/data` | 403 (error envelope) for this account — eligibility-gated. |
| `POST /rest/tas/data` | big payload built by `temporary-additional-support/controllers/common`: `{ …tas fields, client: <client serialized>, income, accommodationPayments[], … }` (from code). |
| `GET /rest/tas/reasonableSteps` | **tested.** `{ reasonableSteps: [{ id, title, description, somethingElseStep }] }` (17 rows). |
| `GET /rest/tas/otherIncomeProps` | `tas/other-income-prop` findAll (default path, untested). |

### 6.13 Miscellaneous

- `GET /rest/sso-session` **tested** `{ returnToUrl, timeRemaining }`.
- Static: `GET /` or `/dashboard` serves the SPA HTML with all config meta tags (feature flags, limits, asset manifest).
- Version check: `GET /rest/session.versionNumber` vs the bundle's version; mismatch makes the SPA reload.

## 7. Ember Data model fields (response/record shapes)

```
accommodation-cost: dateStopped, type, addressText, amount, isTypeInferred, rent, board, ownHouse, emergencyOrTransitional
accommodation-payment: type, amount, frequency, startDate, stopDate, changeDate, status, description, occupancyAmount, paymentType, firstName, middleName, lastName, dateOfBirth, email, mobilePhone, otherPhone
accommodation/rent: landlordName, landlordPhone, isHousingNZ, hasWaterRates   accommodation/board: landlordName, landlordPhone   accommodation/own-house: costs
address: addressText, line1, line2, suburb, city, country, postalCode, dateOfMove
application/datum: restrictNextSteps, isActiveClient, isComplicated, currentApplicationAppointmentReason, workingAgeApplication, superApplication, workingAgeAppointment, superAppointment
application/detail: referenceNumber, date, isExpiring, obligations, potentialObligation, isObligationAccepted, hasPartner, isPartner, partnerNeedsToTakeAction, primaryFirstName, primaryLastName, acceptanceRequired, isYouth, isProcessing, isTransfer, hasMedCert, applicationSubmittedFirstName, applicationSubmittedLastName, isJobSeekerProfileDisplayed, isJobSeekerProfileComplete, categories, partnersCategories, showAgreeResponsibilities, showIdentityButton, isIdentityComplete, identityButtonAction, showSupportingDocButton, isSupportingDocComplete, supportingDocButtonAction, showObligationButton, isObligationComplete, obligationButtonAction, showJspPreBenefitButton, isJspPreBenefitComplete, jspPreBenefitButtonAction, hasDocumentSubType, type
appointment: date, endDate, type, category, topic, personMeeting, isCancellable, isReschedulable, hasRescheduled, display20WorkingDaysRule, location, reasons, status
appointment/book: category, clientRequirementTypes, date, appointmentId, locationId, notes, reasonIds
appointment/callback: contactNumber, locationId, reasonIds, requestAppointmentType
appointment/check: mustCall, limitReached, topic, isSeminarAvailable, isPhoneAvailable, isInPersonAvailable, existing, appointmentHeaderDetails, appointmentFooterDetails
appointment/location: name, directions, address
benefit-summary / benefit: status, type, name, productId, bankPaymentAmount, nextPaymentDate, cardPaymentAmount, nextPaymentTotal (+ details)
bfc: fromDate, trafficLightStatus, family, otherIncomeBeforeTax, otherIncomeAfterTax, weeklyPayments, wages, fortnightlyPayments, childDisabilityAllowance, assets, debtsWithUs, otherDebts, redirections, childcareAssistances, disabilityAllowances, accommodationCosts, tas, specialBenefitCosts
card: cardNo, pan, balance, status, isBlocked, valueDate, hasNewPayment, expiryDate, isPinSet, pinSetDate, hasPinAttemptsBeenExceeded   card-detail: + transactions, subAccounts
child: firstName, benefits, communityServicesCard
client: see 6.1   contact-info: preferred, preferredEmail, homeEmail, workEmail, homePhone, workPhone, cellPhone, fax
course-detail: courseId, title, shortDescription, longDescription, providerId, providerName, providerEmailId
cyc-status: isApplicationComplete   engagement-status: isApplicationComplete, isAppointmentNeeded, isPartnerRCU, isPartnerTREP, showBookLink
debt: isPreviousDebt, type, description, dateEstablished, originalAmount, repaidAmount, owingAmount   debt/repayment: description, date, amount
document: isOnThePhoneWithMSD, applicationReferenceNum, hasAgreed1-3 (not sent), hasGenericUpload, whatStep, businessContext, uploadAction, caseReference, applicationIdentity, files
document-category: categoryId, parentCategoryId, name, typeCode, cmsCode, context, metadata, children, partnerChildren   document-prev-uploaded: fileNames
emergency-housing: contactNumber, dateOfNeed, numberOfDependents, region, town
employment-plan-activity: dueBy, description   job-search-activity: activityDate, employerName, role, status, lastUpdated, applicationMethod, applicationMethodDesc
hardship: count, isPrevStepOther, stpCandidate, chosenCard, hasIncome, hasIncomeChanged, hasAssets, haveAssetsChanged, whyNotAssets, stepsTaken, stepsTakenOther, stepToTake, stepToTakeOther, hasTakenPreviousStep, agreeToRepayments, cantUpload, dental, food, schoolStationery, schoolUniform, types
hardship/data: isStpCandidate, count, totalAssets, partnerAssets, partnerIncome, lastApplication, food, dental, schoolUniforms, schoolStationery
hardship/dental: maxAmount, sngAmount, grantAmount, advanceAmount, recoveryRate, whoFor, typeOfTreatment, isPaidForByOther, howMuchNeed, eligibility
hardship/food: whatHasHappened, whatHasHappenedOther, whyHadToPay, howMuchPaid, howMuchNeed, sngAmount, balance, sixMonthFoodAllowance, maxAmount, eligibility
hardship/school: sngAmount, maxAmount, grantAmount, advanceAmount, recoveryRate, childData, whoFor, hasAppliedForSYSP, eligibility
housing-register: hasRelationshipChanged, hasChildrenChanged, hasIncomeChanged, hasLivingSituationOrLodgingCostsChanged
income: fromDate, declareWagesStartDate, total, lastDeclarationAmount, frequency, productId, displaySummary, incomeDetails
income/declaration: wages, date, childcareCosts   income/declaration/employer: name   wage: employer, totalTime, totalIncome, type, isDaily, hourlyRate, weeklyTotal, weeklyTime
job: jobTitle, jobType, employmentConditions, minRateOfPay, maxRateOfPay, rateOfPayFrequency, jobSuburb, jobDistrict, displayPayonListing, workplaceArrangement
letter: type, date, size, hasRead   banner: type, title, subTitle, text, url, urlTitle, level   tile: id, featureFlag
medical-certificate: showMedicalCertificate, expiryDate, isHighPriority, isRenewable, mustContactUs, showExpiringBanner, showExpiredBanner, isReadyToWork, hasJobseekerProfile
notification: title, dueBy, benefitType, isGeneratedId, outcome   one-off-cost: category, isMore, title, isChecked, outcome   outcome: type, clientRequirementGroups
reasonable-step: title, description, isChecked   supplier: name, city, suburb, gstNumber, amount
temporary-additional-support: dueBy, partner, familyAssistance, assets, partnerAssets, nonCashAssets, healthAndDisabilityCosts, partnerHealthAndDisability, otherHealthAndDisability, otherEssentialCosts, childSupport, businessExpenses, landlordDetails, childrenHealthAndDisability, accommodationCost, partnerIncome
traffic-light/rjs-activity: weekCode, startDate, endDate, activityCount   upskilling-activity: weekCode, startDate, endDate, courses
```

## 8. SPA routes (for deep links)

Host: `/dashboard`, `/housing-declaration`, `/confirm-boarders-or-renters/:declaration_id`, `/realme/callback`,
`/exception/{server-busy|server-error|not-permitted|page-not-found|timeout|unknown-phone-email|maintenance|outage|click-to-enrol|unavailable}`,
`/accessibility`, `/terms-of-use`, `/legal`, `/contact`. Login engine: `/` (welcome), `/login`, `/login/verify-device`,
`/login/logged-out`, `/login/register/{verify|choose-login-method|create-pin}`.

Engines: `/appointments/:appointment_id`, `/appointments/book/{schedule|select-date|select-time}`,
`/appointments/book/:appointment_id/reschedule`; `/benefits/:product_id[/:secondary_index]`; `/cards/:card_detail_id`,
`/cards/set-pin/:card_detail_id`; `/applications/:type/{family|partner|youth|processing|med-cert|obligations|civ/passport|civ/driver-licence|different-document|provide-id|get-id|before-you-start}`,
`/applications/:type/subtype/:subtype_code/{child|upload|agree-terms}`, `/applications/civ-callback[-retry]`;
`/debt` (overview), `/debt/repayments`; `/finance`; `/find-a-job/job-search`; `/hardship/{choose-card|check-income-changed|check-has-income|check-assets-changed|check-has-assets|y-u-no-use-assets|steps-taken|steps-to-take|previous-step|confirm-details|debt-repayments|upload-evidence|choose-suppliers|food/how-much-need|dental/treatment-details|dental/how-much-need|school-stationery/…|school-uniforms/…}`;
`/housing/{emergency/date-of-need|emergency/questions|info|info-youth|stay-in-home}`; `/housing-register/{circumstances|confirm}`;
`/income/declare/{childcare-costs|confirm|cant}`; `/letters`; `/medical-certificate/{how-to-renew|ready-to-work/review-obligations|ready-to-work/confirm|ready-to-work/transfer-to-jobseeker}`;
`/my-eligibility`; `/profile/update-accommodation-costs/…`, `/profile/update-address/…`, `/profile/update-contact-details[/confirm]`,
`/profile/update-relationships`, `/profile/upload-document/{upload-evidence|agreement}`; `/something-changed/{cost-one-off|cost-ongoing|cost-what-kind}`;
`/temporary-additional-support/…` (many steps); `/traffic-light/…`; `/apply/super/family-situation`, `/apply/working-age/{family-situation|reason-for-apply}`.

## 9. Config constants (`index.html` meta `my-msd/config/environment`)

`sessionTimeout` 600 (SPA fallback; server says 900), `sessionTimeoutWarningAfter` 60, `userActivityThrottleSpacing` 30,
`clientVerificationCodeLength` 6, `smsCodeSendMax` 4, `enabledLoginMethods` ["pin","realme"], `maxDeclarationNumWages` 10,
`maxChildcareCosts` 9999.99, `maxHardshipAmount` 9999.99, `maxAssets` 9999999.99, `minAddressLength` 7,
`townsQueryThrottle` 300, `warnNumOneOffCosts` 3, `maxNumLetters` 200, `maxSWIFTCommentLength` 30,
`maxUploadEvidenceFiles` 10, `maxNumSuppliers` 4, `trainingWage` 19.16, `clientNumberLength` 9, `pinLength` 4,
`maxAccommodationCosts` 99999.99, `maxBoardAmount` 5000, `maxDeclarationTotalIncome` 5000,
`maxDeclarationWeeklyTime` 7200 (min), `maxDeclarationDailyTime` 1440, `minBusinessExpenseClaim` 1, `maxBusinessExpenseClaim` 50000,
`maxInputLength` 50 / `maxInputLengthLong` 140, `maxNumPeople` 99.

## 10. Observed per-account gaps (2026-10-12)

Not available to this client (so the MCP must treat them as optional): `/rest/employment-plan/job-search-activity` (403 HTML),
`/rest/tas/data` (403 envelope), `/rest/emergency-housing` (403 HTML), `/rest/data/outcomes` (555 envelope).
Need an id: `/rest/course`, `/rest/documentCategory`, `/rest/applicationStep` (404 bare).

## 11. DES — the "MyMSD new" jobs site (new.my.msd.govt.nz), tested 2026-10-12

- Adobe Experience Manager (publish) hosting a React SPA (TanStack Router, Mantine) at `/en/jobs.html`; `#root` carries
  `data-mymsd-url="https://my.msd.govt.nz"` and `data-refdata-url="/bin/sep/v10/refdata.json"`. Fastly CDN in front
  (`x-served-by: cache-akl…`); **no F5 challenge** here — cold plain HTTP works.
- MyMSD links in with `https://new.my.msd.govt.nz/en/jobs/link?action=jobSearch|jobDetail|jobMatch|profile|getstarted&callingapp=myMSD[&id=]`
  (`desUrl` + `desBaseParams` from `GET /rest/session`); the page stores the action in sessionStorage and routes.

### 11.1 Transport rules (all tested)
- API servlets (`/bin/sep/*`, `/bin/auth/check`): JSON in and out. The SPA sends `Content-Type: application/json`,
  `Accept: application/json`, `x-transaction-id: <uuid>`. **POSTs sit behind Sling's referrer filter**: a POST without a
  same-origin `Referer` gets 403 `{"servlet":"…DispatcherServlet…","message":"Forbidden","url":…,"status":"403"}`.
  GETs need nothing special.
- Navigation servlets (`/bin/auth/login|renew|logout`, `/bin/auth-redirect`) **refuse `Sec-Fetch-Mode: cors`** with 403
  `{"ok":false,"error":"forbidden"}`. Node's `fetch` (undici) always sets that header, so these are driven with
  `node:https` directly (curl works too); send Chrome-like navigation headers (`Accept: text/html,…`), no Origin.
- Response envelope: `{ statusCode, responseId, message, results | result, error?: { detail } }`; success is HTTP 200.
  `jobseeker-profile` uses `result`, everything else `results`. Unauthenticated `GET /bin/sep/client-profile` → 401
  `{ "message": "API response error", "error": { "detail": "API returned status 401" } }`; unauthenticated
  `/bin/sep/vacancies/match` → 500 HTML page. Bad refdata query → Apache 400 "Bad Request".

### 11.2 Auth — OAuth 2 code + PKCE against MSD's B2C, policy `b2c_1a_aem`
- Cookies (host-only on new.my.msd.govt.nz, all session-scoped): `__Host-a0`/`__Host-a1` (access token), `__Host-ui`
  (user info), `__Host-csrf` (not HttpOnly — the SPA reads it and passes it as `?csrf=` on apply and renew),
  `__Secure-i0`/`__Secure-i1` (path `/bin/auth/logout`, the id token), `__Secure-ex` (path `/bin/auth-redirect`; the
  PKCE verifier/state cookie set by `/bin/auth/login`), `affinity` (load balancer). Logout and a failed login clear them
  with empty `Set-Cookie`s — Chrome then still lists them, empty, so an import must drop empty values.
- `GET /bin/auth/login?rt=<return path>[&prompt=1][&ipc=1]` → sets `__Secure-ex`, 302 to
  `https://identity.msd.govt.nz/12788802-9a58-4268-a186-7a2f554aeee6/b2c_1a_aem/oauth2/v2.0/authorize?response_type=code&client_id=740be4e9-aadd-4091-8f23-fe4706e7f1fb&scope=openid+https%3A%2F%2Fmsdciam.onmicrosoft.com%2F1%2Fsep.des.client%3Aread%3Awrite&redirect_uri=https%3A%2F%2Fnew.my.msd.govt.nz%2Fbin%2Fauth-redirect&code_challenge=…&code_challenge_method=S256&state=…&nonce=…`.
  Without a B2C SSO cookie that answers 200 HTML: the IdP selection page (`SETTINGS = {"remoteResource":
  "…/sep_idp_selection.html","api":"CombinedSigninAndSignup",…}`, title "Loading...") offering "Log in with MyMSD" /
  "Log in with RealMe" — a person is needed. With SSO alive B2C 302s to `/bin/auth-redirect?code=…&state=…`, the server
  exchanges the code, sets the cookies above and 302s to `rt`. A bare `/bin/auth-redirect` clears the cookies and 302s
  to `/en/jobs/error/login`.
- `POST /bin/auth/check` body `{}` or `{"type":"userInfo"}` → `{ authenticated, reason ("no_session"), remaining (s),
  renew (bool), clientNumber, firstName, lastName, profileCompleteness, profileStatus, migratedUser }` (tested
  unauthenticated: `{"authenticated":false,"reason":"no_session","remaining":0,"renew":false}`). The SPA polls it every
  30 s; idle timeout 14 min, idle logout 15 min 15 s; on `renew: true` it loads `/bin/auth/renew?csrf=<__Host-csrf>` in a
  hidden iframe (B2C `prompt=none`; the landing body contains `{"ok":true|false}`); it stops auto-renewing after 7 idle
  minutes. `GET /bin/auth/logout?rt=` ends the DES session.

### 11.3 Endpoints (`Ga` in `clientlib-react-app`)
| Call | Notes |
|---|---|
| `POST /bin/sep/vacancies/search` body `{ searchTerms?, filters: { occupationGroups?: string[] (codes), locations?: { regions?: string[] (names), districts?: string[] (names) } } }` | **public, tested.** SPA limits: at least one of the three; `searchTerms` ≤ 50 chars; regions + districts ≤ 10. → `results: { totalVacancies, suitableVacancies: [ { vacancyId, recordId, vacancyTitle, vacancyType (Permanent/Fixed-term/Seasonal/Casual), fullPartTime (Full-time/Part-time), vacancyStatus, payType ("Hourly rate"/"Annual salary"), displayPayOnListing, minimumPay?, maximumPay?, isExternal, workPlaceArrangement (On-site/Remote/Hybrid/Work from home), hasCWSC, searchRelevanceScore, industry {code,value}, occupation {name, occupationCode, occupationGroup {name, occupationGroupCode}}, locations {locationCount, regions[], districts[], suburbs[]}, vacancyPosting {postingURL, startDate, endDate}, company? {name}, match? {score, label} } ] }` |
| `GET /bin/sep/vacancies/details?vacancyId=` | **public, tested.** Signed in it adds `client { specialCautionToken? }` and, once applied, `applicationForm { applicationFormId, applicationFormName, submittedDateTime, applicationStage }`. `vacancyDetails` = the search shape plus `vacancyDescription` (HTML), `isPublic`, `hireDateType` (Set date/Immediate start/Negotiable), `expectedHireDate`, `employmentEndDate`, `sellingPoint1..3`, `onTheJobTrainingProvided`, `preEmploymentChecks[]`, `workSchedule`, `workDays[]`, `workHours[]`, `weeklyHours`, `experienceRequired`, `locations [{suburb, district, region: {code, value}}]`, `vacancyPosting {postingType External/Internal, postingURL, startDate, endDate}`, `competencies {knowledge[], skills[], strengths[], languageProficiencies [{language, proficiencies[]}]}`, `credentials [{code, value, category}]`, `otherQualifications[]`, `credentialEndorsements[]`. |
| `GET /bin/sep/vacancies/match?limit=N` | signed in. `results.matchingVacancies[]` (search shape with `locations: [{region, district, suburb}]` and `match {score, label}`); 404 means none. |
| `GET /bin/sep/client-profile` | signed in. `results: { person { firstName, lastName, email, phone, clientNumber, personOtherStreet/City/PostalCode/Country/State, specialCautionToken, migratedUser }, preference { preferenceId, preferredLanguage {id}, employmentCommunicationPreference (Email / SMS(Text Message) / Both) }, jobseeker { jobseekerId, status Active/Inactive, profileCompleteness Incomplete/Complete } }` |
| `GET /bin/sep/jobseeker-profile` | signed in. `result: { profileStatus, jobseekerId, hasAnyNzdriversLicence, driverlicence {licencesClass[], endorsements[]}, languageProficiencies[], educations[], workExperienceAvailable, workExperiences[], workSkills[], otherSkills[], strengths[], reliableTransportAvailable, workAvailability {…}, locationsInterested[], jobsInterested[], personal {summary} }`. Editing happens in the AEM form wizard at `/en/forms/jsp` — not an API. |
| `GET /bin/sep/job-applications` | signed in. `results: { totalApplications, applications: [ { applicationFormId, applicationFormName, submittedDateTime, applicationStage (Submitted / On-Hold / Shortlisted / Return to MSD / Withdrawn / Cancelled / Unsuccessful / Successful), applicationStageReason, vacancy { vacancyId, vacancyTitle, vacancyType, fullPartTime, workplaceArrangement, vacancyStatus, vacancyStatusReason, industry, occupation, locations[] } } ] }` |
| `POST /bin/sep/vacancy-apply-submit?csrf=<__Host-csrf>` body `{ vacancyId, selectedCV: "existing" \| "own", selectedReference: "Yes" \| "No" }` | signed in. The site's 3-step apply flow: CV choice ("Use a CV I already gave to MSD" / "I will send my own CV" = reply to the confirmation email with it), reference yes/no, review. → `results: { applicationFormId, applicationFormName }`. The SPA refuses to start when the client's `specialCautionToken` decodes as blocking, and shows "Applied" when `applicationForm` already exists. |
| `GET /bin/sep/v10/refdata.json?category=userLocations&q=<text>&mode=startswith` | **public, tested.** `{ version, category, query, limit: 10, total, results: [ { code, description, category, children[] } ] }` — island → region → district → suburb tree. Other categories: `industry` answers empty, `industries` 400. |
| `GET /bin/bff/cv` | signed in; downloads the CV MSD holds. |

Saved jobs, saved searches and job notifications are feature-flagged off in the SPA; contact details are changed on
MyMSD (profile), the DES contact-preferences page only links there.
