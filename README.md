# Unemployment MCP 😭

> *AI replacing jobless activities.*

An MCP server that lets Claude run your **MyMSD** account (my.msd.govt.nz — Work and Income / Ministry of Social
Development, New Zealand) and **DES**, MSD's jobs site (new.my.msd.govt.nz). The robot declares your wages, books the
appointment, reads the letter, fills in the job-search log and applies for the job, while you lie on the floor. 😭

It talks to the sites the way their own web pages do — plain Node `fetch` against their HTTP APIs, no browser in the
loop, nothing scraped off a screen. **51 tools.** Every action is a dry run until you say `confirm: true`, because the
only thing worse than being unemployed is being unemployed *and* having a robot re-declare your wages by accident.

## What it does (through tears)

**MyMSD — `mymsd_*`, 42 tools**

- 😭 **Reads:** dashboard, profile, benefits and next payment, letters (with PDF download), debt, financial summary,
  payment cards, appointments and availability, income, employment plan, matched jobs, one-off costs and hardship
  eligibility, medical certificate, housing, applications, TAS.
- 😤 **Actions:** declare wages, book / cancel / call-back appointments, update contact details, address and
  accommodation costs, letters by post or email, job-search and obligation reporting, card PIN, document upload,
  hardship application, Housing Register check-in, emergency housing, medical-certificate ready-to-work, application
  steps, TAS, boarder declarations.

**DES, the jobs site — `des_*`, 9 tools**

- 🔍 `des_search`, `des_job`, `des_locations` — public, no sign-in. Go find a job with no feelings involved.
- 💼 `des_matches`, `des_profile`, `des_applications`, `des_cv` — what MSD thinks you should do with your life.
- 📨 `des_apply` — the site's three-step application (which CV, do you have a referee, submit) in one call. Dry run by
  default; refuses on its own when you already applied, the job isn't open, or your record says no.
- 🔐 `des_auth` — sign-in state and sign-in.

Every tool answers with a plain-language summary first, then the site's JSON.

## Install

```sh
npm install --omit=optional && npm run build
```

Node ≥ 22.13 (the Chrome import reads Chrome's cookie store with `node:sqlite`). The optional browser — only needed when
MSD's bot defence rejects imported cookies, or to use the `login` actions as a window of their own:
`npm i cloakbrowser playwright-core`.

Register it with Claude Code (`~/.claude.json`) or any MCP client:

```json
"mymsd": { "type": "stdio", "command": "node", "args": ["/path/to/unemployment-mcp/dist/server.js"] }
```

## Sign in (the part where a human is still needed 😭)

1. Sign in at https://my.msd.govt.nz in Chrome (RealMe, or client number + PIN). Give Chrome a few seconds to finish.
2. `mymsd_auth import_chrome` — copies that sign-in out of Chrome's Default profile (macOS asks once for Keychain
   access; choose **Always Allow**). It also carries the DES cookies and the identity provider's single-sign-on cookie,
   so DES usually comes along for free; otherwise `des_auth import_chrome` after signing in at new.my.msd.govt.nz
   (use "Log in with MyMSD" on its chooser).

From then on the server keeps itself signed in: when MyMSD's 15-minute idle timeout or DES's 14-minute one expires, it
silently replays the single-sign-on for as long as MSD's identity provider still remembers you. When that is gone
too, `mymsd_auth login` / `des_auth login` (a browser window with the optional package, or your own Chrome and
`import_chrome` again).

Two things end the silent repair early, both outside this server: the identity provider rotates its sign-in cookie
each time it is used, so a copy taken from Chrome goes stale once another client uses it; and **a MyMSD tab left open
in any browser signs you out of RealMe entirely after 15 idle minutes** (the site's timeout runs a single logout).
Close MyMSD tabs you are not using. The server itself never signs you out.

Session file: `~/.mymsd-mcp/session.json` (cookies only, mode 600). `mymsd_auth forget` / `des_auth forget` delete it.

## Writes are dry runs by default

Every tool that changes something takes `confirm`. Without `confirm: true` it validates the input, shows the exact
request (method, path, body) and says in plain words what MSD will record — and sends nothing. The csrf token is
masked in what it shows you.

## Not available on this account

Endpoints MSD gates by eligibility come back as "not available on this account": the job-search activity log (unless
required), TAS data, emergency housing, application steps without an application. Tools built for them are marked
"untested on this account" in their descriptions. DES's CV download answers HTTP 500 from their side when there is no
CV document on file.

## Development

`npm test` (offline, invented fixtures — 109 tests), `npm run smoke` (live: every read tool, every write tool as a dry
run; `SMOKE_IMPORT=1` imports the Chrome sign-in first, `SMOKE_ONLY=des` runs just the DES part). API notes, every
endpoint and shape, how the sign-ins work: `NATIVE-NOTES.md`. Design: `docs/superpowers/specs/`, plans:
`docs/superpowers/plans/`. Plain-language state: `STATUS.md`, `IMPLEMENTED.md`.

## Disclaimer

Not affiliated with, endorsed by or supported by the Ministry of Social Development. It uses your own sign-in, on your
own account, at your own risk, and makes the same requests the sites' own pages make — be gentle with their servers
and never point it at anyone else's account. The sob emoji is load-bearing. 😭

ISC licence.
