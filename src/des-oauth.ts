import type { DesHttp } from "./des-http.js";
import { SsoDeadError } from "./http.js";
import { DES_ORIGIN } from "./paths.js";
import { parseAutoPostForm } from "./sso.js";

const HOP_HOSTS = ["new.my.msd.govt.nz", "identity.msd.govt.nz"];
const MAX_HOPS = 12;
/** where the sign-in lands: the signed-in "My jobs" page */
export const DES_RETURN = "/my-jobs/";
export const desLoginUrl = (): string => `${DES_ORIGIN}/bin/auth/login?rt=${encodeURIComponent(DES_RETURN)}`;

/**
 * Replays DES's OAuth sign-in natively: /bin/auth/login → B2C authorize (answered from B2C's SSO cookie) →
 * /bin/auth-redirect?code= (DES exchanges the code and sets its cookies) → the return page. A page that needs a
 * person, DES's own error page, a hop to a host we do not drive, a refusal or a loop is an SsoDeadError.
 */
export async function repairDes(http: DesHttp): Promise<void> {
  let url = desLoginUrl();
  let form: string | undefined;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const u = new URL(url);
    if (!HOP_HOSTS.includes(u.hostname)) throw new SsoDeadError(`sign-in moved to ${u.hostname}, which needs a person`);
    const r = await http.nav(url, form);
    form = undefined;
    if (r.status >= 300 && r.status < 400 && r.location) {
      url = new URL(r.location, url).toString();
      if (/\/error\//.test(new URL(url).pathname)) throw new SsoDeadError(`DES rejected the sign-in (${url})`);
      continue;
    }
    if (r.status === 403) throw new SsoDeadError(`${u.pathname} refused the request (403 ${r.body.slice(0, 80).trim()})`);
    if (u.hostname === "identity.msd.govt.nz") {
      const f = parseAutoPostForm(r.body, url);
      if (f) {
        url = f.action;
        form = new URLSearchParams(f.fields).toString();
        continue;
      }
      throw new SsoDeadError("the identity provider wants a person (it showed its sign-in page)");
    }
    if (r.status === 200) return;
    throw new SsoDeadError(`unexpected HTTP ${r.status} from ${url}`);
  }
  throw new SsoDeadError("too many redirects during sign-in");
}
