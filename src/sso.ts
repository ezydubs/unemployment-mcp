import { BotDefenceError, Http, SsoDeadError, isChallengePage } from "./http.js";
import { ORIGIN } from "./paths.js";

export interface AutoPostForm {
  action: string;
  fields: Record<string, string>;
}

/** Hosts a sign-in hand-off may bounce through: the site, MSD's B2C IdP, RealMe. */
const HOP_HOSTS = ["my.msd.govt.nz", "identity.msd.govt.nz", "login.realme.govt.nz"];

const attr = (tag: string, name: string): string | undefined =>
  tag
    .match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
    ?.slice(1)
    .find((v) => v !== undefined);

const decode = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The first POST form carrying hidden inputs (a SAML/B2C auto-post page); null when the page wants a person to type. */
export function parseAutoPostForm(html: string, base = ORIGIN): AutoPostForm | null {
  for (const form of html.match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) ?? []) {
    const open = form.match(/<form\b[^>]*>/i)![0];
    if (!/\bmethod\s*=\s*["']?post/i.test(open)) continue;
    const fields: Record<string, string> = {};
    for (const input of form.match(/<input\b[^>]*>/gi) ?? []) {
      if (!/\btype\s*=\s*["']?hidden/i.test(input)) continue;
      const name = attr(input, "name");
      if (name) fields[decode(name)] = decode(attr(input, "value") ?? "");
    }
    if (Object.keys(fields).length) return { action: new URL(decode(attr(open, "action") ?? ""), base).toString(), fields };
  }
  return null;
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

async function followRedirects(http: Http, res: Response, max = 5): Promise<Response> {
  for (let i = 0; i < max && res.status >= 300 && res.status < 400; i++) {
    const loc = res.headers.get("location");
    if (!loc) break;
    res = await http.raw(new URL(loc, res.url || ORIGIN).toString(), { headers: { accept: "text/html,*/*" } });
  }
  return res;
}

/**
 * Silent sign-in, the way the SPA does it when its session is gone: ask the site for its SSO redirect, post the SAML
 * request to Azure B2C (which answers from its own SSO cookie without showing a page), post the SAML response back,
 * follow the callback. Throws SsoDeadError when any hop wants a person.
 */
export async function repairSso(http: Http): Promise<void> {
  const start = await http.get("/idpsaml/ciamsession", { intendedUrl: "%2Fdashboard" });
  const redirectUrl = start?.redirectUrl;
  if (typeof redirectUrl !== "string") throw new SsoDeadError("MyMSD did not offer a single-sign-on redirect");
  let res = await http.raw(redirectUrl, { headers: { accept: "text/html,*/*" } });
  for (let hop = 0; hop < 6; hop++) {
    res = await followRedirects(http, res);
    const page = await res.text();
    if (isChallengePage(page)) throw new BotDefenceError("MyMSD's bot defence challenged the sign-in hand-off");
    const form = parseAutoPostForm(page, res.url || ORIGIN);
    if (!form) throw new SsoDeadError(`the sign-in provider wants an interactive login (no hand-off form on ${hostOf(res.url) || "the page"})`);
    const host = hostOf(form.action);
    if (!HOP_HOSTS.includes(host)) throw new SsoDeadError(`unexpected sign-in hop to ${host}`);
    res = await http.raw(form.action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,*/*", origin: `https://${hostOf(res.url) || host}` },
      body: new URLSearchParams(form.fields).toString(),
    });
    if (new URL(form.action).pathname === "/session/login/samlResponse") {
      const loc = res.headers.get("location") ?? "";
      const status = new URL(loc, ORIGIN).searchParams.get("status");
      if (res.status >= 300 && res.status < 400 && status === "success") {
        await followRedirects(http, res);
        return;
      }
      throw new SsoDeadError(`MyMSD rejected the sign-in (status ${status ?? res.status})`);
    }
  }
  throw new SsoDeadError("too many sign-in hops");
}
