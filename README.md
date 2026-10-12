# mymsd-mcp

MCP server for **MyMSD** (my.msd.govt.nz, Ministry of Social Development, New Zealand) over the site's own HTTP API —
plain Node `fetch`, no browser in the loop.

Reads: dashboard, profile, benefits and payments, letters (with PDF download), debt, financial information, payment
cards, appointments and availability, income, employment plan, jobs, one-off costs and hardship eligibility, medical
certificate, housing, applications, TAS. Actions: declare wages, book/cancel/call-back appointments, update contact
details, address and accommodation costs, letters by post or email, job-search and obligation reporting, card PIN,
document upload, hardship application, Housing Register check-in, emergency housing, medical-certificate ready-to-work,
application steps, TAS, boarder declarations. 42 tools, all prefixed `mymsd_`.

## Install

```sh
npm install --omit=optional && npm run build
```

Optional browser — only needed when MSD's bot defence rejects imported cookies, or to use `mymsd_auth login` as a
window: `npm i cloakbrowser playwright-core`.

Register in `~/.claude.json`:

```json
"mymsd": { "type": "stdio", "command": "/opt/homebrew/opt/node@24/bin/node", "args": ["/Users/test/Downloads/mymsd-mcp/dist/server.js"] }
```

## Sign in

1. Sign in at https://my.msd.govt.nz in Chrome (RealMe, or client number + PIN).
2. `mymsd_auth import_chrome` — reads Chrome's cookies (macOS asks once for Keychain access; choose **Always Allow**).

The session then repairs itself: when MyMSD's 15-minute idle timeout or 2-hour session expires, the server replays the
RealMe single-sign-on silently for as long as MSD's identity provider still remembers you. When that is gone too,
`mymsd_auth login` (a browser window, or your own Chrome plus `import_chrome` again).

Two things end the silent repair early, both outside this server: MSD's identity provider rotates its sign-in cookie
each time it is used, so a copy taken from Chrome goes stale once another client uses it; and a MyMSD tab left open
in any browser signs you out of RealMe entirely after 15 idle minutes (the site's timeout runs a SAML single logout).
Close MyMSD tabs you are not using. The server itself never signs you out.

Session file: `~/.mymsd-mcp/session.json` (cookies only, mode 600). `mymsd_auth forget` deletes it.

## Writes are dry runs by default

Every tool that changes something takes `confirm`. Without `confirm: true` it validates the input, shows the exact
request (method, path, body) and says in plain words what MSD will record — and sends nothing.

## Not available on this account

Endpoints MSD gates by eligibility come back as "not available on this account": the job-search activity log (unless
required), TAS data, emergency housing, application steps without an application. Tools built for them are marked
"untested on this account" in their descriptions.

## Development

`npm test` (offline, invented fixtures), `npm run smoke` (live: every read tool, every write tool as a dry run;
`SMOKE_IMPORT=1` imports the Chrome sign-in first). API notes: `NATIVE-NOTES.md`. Design: `docs/superpowers/specs/`,
plan: `docs/superpowers/plans/`.
