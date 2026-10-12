import { test } from "node:test";
import assert from "node:assert/strict";
const { CookieJar, parseSetCookie, domainMatches, pathMatches } = await import("../dist/jar.js");

const c = (over) => ({ name: "a", value: "1", domain: "my.msd.govt.nz", path: "/", expires: -1, secure: true, httpOnly: false, ...over });

test("domain cookies match subdomains, host-only cookies match the host alone", () => {
  assert.ok(domainMatches("my.msd.govt.nz", ".msd.govt.nz"));
  assert.ok(domainMatches("msd.govt.nz", ".msd.govt.nz"));
  assert.ok(!domainMatches("evilmsd.govt.nz", ".msd.govt.nz"));
  assert.ok(domainMatches("my.msd.govt.nz", "my.msd.govt.nz"));
  assert.ok(!domainMatches("new.my.msd.govt.nz", "my.msd.govt.nz"));
  assert.ok(pathMatches("/rest/session", "/"));
  assert.ok(pathMatches("/rest/session", "/rest"));
  assert.ok(!pathMatches("/restful", "/rest"));
});

test("header picks matching, unexpired cookies, longest path first, secure only on https", () => {
  const jar = new CookieJar([
    c({ name: "JSESSIONID", value: "s" }),
    c({ name: "_ga", value: "g", domain: ".msd.govt.nz", secure: false }),
    c({ name: "deep", value: "d", path: "/rest" }),
    c({ name: "old", value: "x", expires: 1 }),
    c({ name: "other", value: "o", domain: "identity.msd.govt.nz" }),
  ]);
  assert.equal(jar.header("https://my.msd.govt.nz/rest/session"), "deep=d; JSESSIONID=s; _ga=g");
  assert.equal(jar.header("http://my.msd.govt.nz/rest/session"), "_ga=g");
  assert.equal(jar.header("https://identity.msd.govt.nz/x"), "_ga=g; other=o", "a .msd.govt.nz domain cookie is sent to every msd.govt.nz host");
  assert.equal(jar.size, 4);
});

test("Set-Cookie lines are parsed with attributes; Max-Age=0 and past Expires delete", () => {
  const url = new URL("https://my.msd.govt.nz/rest/session");
  const k = parseSetCookie("JSESSIONID=abc; Max-Age=7500; Expires=Mon, 12 Oct 2026 05:22:59 GMT; Path=/; Secure; HttpOnly; SameSite=None", url);
  assert.equal(k.name, "JSESSIONID");
  assert.equal(k.value, "abc");
  assert.equal(k.domain, "my.msd.govt.nz");
  assert.equal(k.path, "/");
  assert.ok(k.secure && k.httpOnly);
  assert.ok(k.expires > Date.now() / 1000 + 7000);
  const d = parseSetCookie("_gid=1; Domain=.msd.govt.nz; Path=/", url);
  assert.equal(d.domain, ".msd.govt.nz");
  assert.equal(parseSetCookie("TS4a38d0e9029=zz; Max-Age=30; Path=/", url).expires > 0, true);
  assert.equal(parseSetCookie("garbage", url), null);
  const jar = new CookieJar([c({ name: "TSeae47ed5027", value: "old" })]);
  assert.equal(jar.store("https://my.msd.govt.nz/rest/session", ["TSeae47ed5027=new; Path=/"]), 1);
  assert.equal(jar.header("https://my.msd.govt.nz/"), "TSeae47ed5027=new");
  jar.store("https://my.msd.govt.nz/rest/session", ["TSeae47ed5027=gone; Max-Age=0; Path=/"]);
  assert.equal(jar.header("https://my.msd.govt.nz/"), "");
  jar.store("https://my.msd.govt.nz/rest/session", ["x=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
  assert.equal(jar.size, 0);
});

test("a Domain attribute that does not cover the response host is ignored (host-only cookie)", () => {
  const k = parseSetCookie("evil=1; Domain=example.com", new URL("https://my.msd.govt.nz/"));
  assert.equal(k.domain, "my.msd.govt.nz");
});

test("JSON round trip, has, names and remove", () => {
  const jar = CookieJar.fromJSON([c({ name: "a" }), c({ name: "b", domain: ".login.realme.govt.nz" })]);
  assert.deepEqual(CookieJar.fromJSON(JSON.parse(JSON.stringify(jar))).toJSON(), jar.toJSON());
  assert.ok(jar.has("my.msd.govt.nz"));
  assert.ok(jar.has("login.realme.govt.nz"));
  assert.ok(!jar.has("identity.msd.govt.nz"));
  assert.deepEqual(jar.names("my.msd.govt.nz"), ["a"]);
  assert.equal(jar.remove((x) => x.name === "a"), 1);
  assert.equal(jar.size, 1);
});
