import { describe, expect, it, vi } from "vitest";
import { createCookieJar, createHostThrottle, fetchDocument } from "./fetch";
import { DOCUMENT_LIMITS, DOCUMENT_USER_AGENT } from "./limits";
import { KIND_MIME } from "./sniff";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

const PDF = bytes("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const DOCX = bytes([0x50, 0x4b, 0x03, 0x04], "[Content_Types].xml word/document.xml");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], "Teknik/sartname.pdf");
const OLE2_DOC = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "Microsoft Word 97-2003");

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Answers from a table of URLs and records every request. */
function fakeServer(routes: Record<string, Route>) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    return route(init);
  };
  return { fetch, requests };
}

const answer =
  (body: BodyInit | null, headers: HeadersInit = {}, status = 200): Route =>
  () =>
    new Response(body, { status, headers });

/** A body that never ends, counting what was pulled from it. */
function endless(first: Uint8Array, chunkSize = 64 * 1024) {
  const stats = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = stats.pulled === 0 ? first : new Uint8Array(chunkSize).fill(0x20);
      stats.pulled += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

/** Never answers until the request is aborted, like a server that hangs. */
const hanging: Route = (init) =>
  new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));

const BASE = "https://ihale.example.gov";

async function fetchOne(route: Route, url = `${BASE}/download/spec.pdf`, options: Parameters<typeof fetchDocument>[1] = {}) {
  const server = fakeServer({ [url]: route });
  const result = await fetchDocument(url, { fetch: server.fetch, ...options });
  return { result, requests: server.requests };
}

describe("fetchDocument files", () => {
  it("takes a PDF with its name and sends a plain GET that names us", async () => {
    const { result, requests } = await fetchOne(
      answer(PDF, { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Teknik Sartname.pdf"' }),
    );
    expect(result).toEqual({
      kind: "file",
      fileKind: "pdf",
      bytes: PDF,
      mime: KIND_MIME.pdf,
      filename: "Teknik Sartname.pdf",
      finalUrl: `${BASE}/download/spec.pdf`,
    });
    expect(requests).toHaveLength(1);
    const init = requests[0]!.init!;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("user-agent")).toBe(DOCUMENT_USER_AGENT);
    expect(new Headers(init.headers).get("accept")).toBe("*/*");
  });

  it("takes a ZIP, named after the link when the server gives no name", async () => {
    const url = `${BASE}/files/ihale%20dokumanlari.zip`;
    const { result } = await fetchOne(answer(ZIP, { "Content-Type": "application/zip" }), url);
    expect(result).toMatchObject({ kind: "file", fileKind: "zip", mime: KIND_MIME.zip, filename: "ihale dokumanlari.zip", finalUrl: url });
  });

  it("tells a DOCX sent as application/octet-stream by its content", async () => {
    const { result } = await fetchOne(
      answer(DOCX, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=Fiyat_Cetveli.docx" }),
      `${BASE}/Attachment/7781`,
    );
    expect(result).toMatchObject({ kind: "file", fileKind: "docx", mime: KIND_MIME.docx, filename: "Fiyat_Cetveli.docx" });
  });

  it("trusts the bytes over a Content-Type that says HTML", async () => {
    const { result } = await fetchOne(answer(PDF, { "Content-Type": "text/html; charset=utf-8" }));
    expect(result).toMatchObject({ kind: "file", fileKind: "pdf" });
  });
});

describe("fetchDocument file names", () => {
  const named = async (disposition: string) =>
    (await fetchOne(answer(PDF, { "Content-Type": "application/pdf", "Content-Disposition": disposition }), `${BASE}/get?id=1`)).result;

  it("prefers the UTF-8 name of filename* (RFC 6266)", async () => {
    const result = await named(`attachment; filename="Technicka specifikace.pdf"; filename*=UTF-8''Technick%C3%A1%20specifikace.pdf`);
    expect(result).toMatchObject({ filename: "Technická specifikace.pdf" });
  });

  it("reads filename* in another charset, and quoted", async () => {
    expect(await named(`attachment; filename*="iso-8859-1''R%E9sum%E9.pdf"`)).toMatchObject({ filename: "Résumé.pdf" });
  });

  it("repairs raw UTF-8 in a plain filename and keeps real Latin-1", async () => {
    // Header values arrive as Latin-1: "á" sent as UTF-8 reads "Ã¡".
    expect(await named('attachment; filename="TechnickÃ¡.pdf"')).toMatchObject({ filename: "Technická.pdf" });
    expect(await named('attachment; filename="Résumé.pdf"')).toMatchObject({ filename: "Résumé.pdf" });
  });

  it("keeps only the file name of a path", async () => {
    expect(await named('attachment; filename="..\\\\..\\\\docs/../Teklif.pdf"')).toMatchObject({ filename: "Teklif.pdf" });
  });

  it("falls back to the link's last part, decoded, or no name", async () => {
    const decoded = await fetchOne(answer(PDF), `${BASE}/files/Teknik%20%C5%9Eartname.pdf?v=2`);
    expect(decoded.result).toMatchObject({ filename: "Teknik Şartname.pdf" });
    const none = await fetchOne(answer(PDF), `${BASE}/`);
    expect(none.result).toMatchObject({ kind: "file", filename: null });
  });
});

describe("fetchDocument pages", () => {
  it("reports a login form", async () => {
    const html = '<html><body><form><input name="user"><input type="password" name="pw"></form></body></html>';
    const { result } = await fetchOne(answer(html, { "Content-Type": "text/html; charset=utf-8" }));
    expect(result).toEqual({ kind: "page", finalUrl: `${BASE}/download/spec.pdf`, login: true, html });
  });

  it("reports a portal page without a login as such", async () => {
    const html = '<!DOCTYPE html><html><head><title>Tender documents</title></head><body><a href="/d/1">Specification</a></body></html>';
    const { result } = await fetchOne(answer(html, { "Content-Type": "text/html" }));
    expect(result).toMatchObject({ kind: "page", login: false });
  });

  it("finds login words in the page's own charset", async () => {
    // "Přihlásit" in windows-1250, as some Czech portals still serve it.
    const html = bytes('<html><head><meta charset="windows-1250"></head><body><a href="/l">P', [0xf8], "ihl", [0xe1], "sit</a></body></html>");
    const { result } = await fetchOne(answer(html, { "Content-Type": "text/html" }));
    expect(result).toMatchObject({ kind: "page", login: true });
  });

  it("tells a page by its doctype when the Content-Type does not say", async () => {
    const html = "\n<!DOCTYPE html>\n<html lang=\"nl\"><body><button>Inloggen</button></body></html>";
    const { result } = await fetchOne(answer(html, { "Content-Type": "application/octet-stream" }));
    expect(result).toMatchObject({ kind: "page", login: true });
  });

  it("reads only the start of a page that does not end", async () => {
    const { stream, stats } = endless(bytes("<!DOCTYPE html><html><body><form><input type='password'>"));
    const { result } = await fetchOne(() => new Response(stream, { headers: { "Content-Type": "text/html" } }));
    expect(result).toMatchObject({ kind: "page", login: true });
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("fetchDocument other content", () => {
  it("stores the type of a file it does not read, and an old .doc by its header", async () => {
    const doc = await fetchOne(
      answer(OLE2_DOC, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="Teklif Mektubu.doc"' }),
    );
    expect(doc.result).toEqual({
      kind: "unsupported",
      mime: "application/msword",
      filename: "Teklif Mektubu.doc",
      finalUrl: `${BASE}/download/spec.pdf`,
    });
    const image = await fetchOne(answer(bytes([0x89, 0x50, 0x4e, 0x47]), { "Content-Type": "image/png" }), `${BASE}/plan.png`);
    expect(image.result).toMatchObject({ kind: "unsupported", mime: "image/png", filename: "plan.png" });
  });

  it("calls an empty answer a failure", async () => {
    const { result } = await fetchOne(answer(null, { "Content-Type": "application/pdf" }));
    expect(result).toMatchObject({ kind: "failed", status: 200, retryable: false, retryAfterMs: null });
  });
});

describe("fetchDocument size limit", () => {
  it("does not download a file whose Content-Length is over the limit", async () => {
    const size = DOCUMENT_LIMITS.fileBytes + 1;
    const { stream, stats } = endless(PDF);
    const { result } = await fetchOne(() => new Response(stream, { headers: { "Content-Type": "application/pdf", "Content-Length": String(size) } }));
    expect(result).toEqual({ kind: "too_large", sizeBytes: size, finalUrl: `${BASE}/download/spec.pdf` });
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(64 * 1024);
  });

  it("stops reading a body without Content-Length once it passes the limit", async () => {
    const { stream, stats } = endless(PDF);
    const maxBytes = 256 * 1024;
    const { result } = await fetchOne(() => new Response(stream, { headers: { "Content-Type": "application/pdf" } }), undefined, { maxBytes });
    expect(result).toEqual({ kind: "too_large", sizeBytes: null, finalUrl: `${BASE}/download/spec.pdf` });
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(maxBytes + 3 * 64 * 1024);
  });

  it("takes a file of exactly the limit", async () => {
    const { result } = await fetchOne(answer(PDF, { "Content-Length": String(PDF.length) }), undefined, { maxBytes: PDF.length });
    expect(result).toMatchObject({ kind: "file", fileKind: "pdf" });
  });
});

describe("fetchDocument redirects", () => {
  it("follows a redirect and reports where the file was", async () => {
    const start = `${BASE}/notice/doc?id=17`;
    const final = `${BASE}/files/Teknik%20%C5%9Eartname.pdf`;
    const server = fakeServer({
      [start]: answer(null, { Location: "/files/Teknik%20%C5%9Eartname.pdf" }, 302),
      [final]: answer(PDF, { "Content-Type": "application/pdf" }),
    });
    const result = await fetchDocument(start, { fetch: server.fetch });
    expect(result).toMatchObject({ kind: "file", fileKind: "pdf", filename: "Teknik Şartname.pdf", finalUrl: final });
    expect(server.requests.map((r) => r.url)).toEqual([start, final]);
    expect(server.requests.every((r) => r.init?.redirect === "manual")).toBe(true);
  });

  it("reports the page a redirect ends on", async () => {
    const server = fakeServer({
      [`${BASE}/d/1`]: answer(null, { Location: "https://portal.example.com/login?next=%2Fd%2F1" }, 303),
      "https://portal.example.com/login?next=%2Fd%2F1": answer("<html><body>Sign in</body></html>", { "Content-Type": "text/html" }),
    });
    expect(await fetchDocument(`${BASE}/d/1`, { fetch: server.fetch })).toEqual({
      kind: "page",
      finalUrl: "https://portal.example.com/login?next=%2Fd%2F1",
      login: true,
      html: "<html><body>Sign in</body></html>",
    });
  });

  it("does not follow a redirect to a local address", async () => {
    const server = fakeServer({ [`${BASE}/d/2`]: answer(null, { Location: "http://169.254.169.254/latest/meta-data" }, 302) });
    expect(await fetchDocument(`${BASE}/d/2`, { fetch: server.fetch })).toMatchObject({ kind: "failed", status: null, retryable: false, retryAfterMs: null });
    expect(server.requests).toHaveLength(1);
  });

  it("calls a portal that redirects to itself a page, without asking again", async () => {
    // platformazakupowa.pl sets a cookie and sends the request back to the same address.
    const self = fakeServer({ [`${BASE}/transakcja/1373180`]: answer(null, { Location: "/transakcja/1373180" }, 302) });
    expect(await fetchDocument(`${BASE}/transakcja/1373180`, { fetch: self.fetch })).toEqual({
      kind: "page",
      finalUrl: `${BASE}/transakcja/1373180`,
      login: false,
      html: "",
    });
    expect(self.requests).toHaveLength(1);

    const round = fakeServer({
      [`${BASE}/a`]: answer(null, { Location: `${BASE}/b` }, 302),
      [`${BASE}/b`]: answer(null, { Location: `${BASE}/a` }, 302),
    });
    expect(await fetchDocument(`${BASE}/a`, { fetch: round.fetch })).toEqual({ kind: "page", finalUrl: `${BASE}/b`, login: false, html: "" });
    expect(round.requests.map((r) => r.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
  });

  it("calls a page what is still redirecting after ten hops", async () => {
    const chain = fakeServer(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${BASE}/r/${i}`, answer(null, { Location: `/r/${i + 1}` }, 307)])));
    expect(await fetchDocument(`${BASE}/r/0`, { fetch: chain.fetch })).toEqual({ kind: "page", finalUrl: `${BASE}/r/10`, login: false, html: "" });
    expect(chain.requests).toHaveLength(11);
  });

  it("fails on a redirect without an address or with a broken one", async () => {
    const nowhere = await fetchOne(answer(null, {}, 302));
    expect(nowhere.result).toMatchObject({ kind: "failed", status: 302, retryable: false, retryAfterMs: null });
    const broken = await fetchOne(answer(null, { Location: "http://[" }, 302));
    expect(broken.result).toMatchObject({ kind: "failed", error: "Geçersiz yönlendirme adresi.", status: 302, retryable: false });
  });
});

describe("fetchDocument failures", () => {
  it("fails on a missing file and on errors worth trying again: 408, 429 and 5xx", async () => {
    const cases: [number, boolean][] = [
      [404, false],
      [410, false],
      [408, true],
      [429, true],
      [500, true],
      [502, true],
      [503, true],
    ];
    for (const [status, retryable] of cases) {
      const { result } = await fetchOne(answer("error", {}, status));
      expect(result).toEqual({ kind: "failed", error: expect.stringContaining(`HTTP ${status}`), status, retryable, retryAfterMs: null });
    }
  });

  it("calls a login or a bot block a page that needs a login", async () => {
    for (const status of [401, 403]) {
      const { result } = await fetchOne(answer("Forbidden", {}, status));
      expect(result).toEqual({ kind: "page", finalUrl: `${BASE}/download/spec.pdf`, login: true, html: "" });
    }
  });

  it("calls a page what other 4xx answers refuse, as servers do for requests that are not a browser's", async () => {
    // evergabe-online.de answers 400 to tenderdocuments.html?id=871102.
    for (const status of [400, 405, 406, 451]) {
      const { result } = await fetchOne(answer("Bad Request", {}, status));
      expect(result).toEqual({ kind: "page", finalUrl: `${BASE}/download/spec.pdf`, login: false, html: "" });
    }
  });

  it("reports the page a redirect ends on with a refusal", async () => {
    const server = fakeServer({
      [`${BASE}/d/9`]: answer(null, { Location: "https://portal.example.com/sso" }, 302),
      "https://portal.example.com/sso": answer("Unauthorized", {}, 401),
    });
    expect(await fetchDocument(`${BASE}/d/9`, { fetch: server.fetch })).toEqual({
      kind: "page",
      finalUrl: "https://portal.example.com/sso",
      login: true,
      html: "",
    });
  });

  it("says why in Turkish", async () => {
    expect((await fetchOne(answer("", {}, 404))).result).toMatchObject({ error: "Dosya bulunamadı (HTTP 404)." });
    expect((await fetchOne(answer("", {}, 500))).result).toMatchObject({ error: "Sunucu hatası (HTTP 500)." });
  });

  it("passes on when a 429 or 503 says to come back", async () => {
    const seconds = await fetchOne(answer("", { "Retry-After": "120" }, 429));
    expect(seconds.result).toMatchObject({ kind: "failed", status: 429, retryable: true, retryAfterMs: 120_000 });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
      const date = await fetchOne(answer("", { "Retry-After": "Fri, 16 Oct 2026 10:30:00 GMT" }, 503));
      expect(date.result).toMatchObject({ kind: "failed", status: 503, retryable: true, retryAfterMs: 30 * 60_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no wait without a readable Retry-After, nor on other errors", async () => {
    expect((await fetchOne(answer("", {}, 429))).result).toMatchObject({ status: 429, retryAfterMs: null });
    expect((await fetchOne(answer("", { "Retry-After": "soon" }, 429))).result).toMatchObject({ status: 429, retryAfterMs: null });
    expect((await fetchOne(answer("", { "Retry-After": "120" }, 500))).result).toMatchObject({ status: 500, retryAfterMs: null });
  });

  it("times out when the server does not answer, or stops half way", async () => {
    const silent = await fetchOne(hanging, undefined, { timeoutMs: 30 });
    expect(silent.result).toMatchObject({ kind: "failed", status: null, retryable: true, retryAfterMs: null, error: expect.stringContaining("Zaman aşımı") });

    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF.subarray(0, 8));
      },
    });
    const halfWay = await fetchOne(() => new Response(stalled, { headers: { "Content-Type": "application/pdf" } }), undefined, { timeoutMs: 30 });
    expect(halfWay.result).toMatchObject({ kind: "failed", status: null, retryable: true, retryAfterMs: null, error: expect.stringContaining("Zaman aşımı") });
  });

  it("can try again after a network error", async () => {
    const refused = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }) });
    };
    expect((await fetchOne(refused)).result).toEqual({
      kind: "failed",
      error: "Bağlantı kurulamadı (ECONNREFUSED).",
      status: null,
      retryable: true,
      retryAfterMs: null,
    });
  });

  it("sends nothing for links it must not fetch", async () => {
    const server = fakeServer({});
    for (const url of [
      "ftp://ihale.example.gov/spec.pdf",
      "https://user:secret@ihale.example.gov/spec.pdf",
      "http://localhost:3000/spec.pdf",
      "http://10.0.0.5/spec.pdf",
      "http://2130706433/spec.pdf",
      "http://[::ffff:127.0.0.1]/spec.pdf",
      "http://[fe80::1]/spec.pdf",
      "dokuman.pdf",
    ]) {
      expect(await fetchDocument(url, { fetch: server.fetch })).toMatchObject({ kind: "failed", status: null, retryable: false, retryAfterMs: null });
    }
    expect(server.requests).toEqual([]);
  });
});

describe("fetchDocument guard", () => {
  /** A guard that turns down some hosts and records every address it is asked about. */
  const guardFor = (blocked: Record<string, "terms" | "robots" | "robots_unavailable">) => {
    const asked: string[] = [];
    const guard = async (url: string) => {
      asked.push(url);
      return blocked[new URL(url).hostname] ?? null;
    };
    return { guard, asked };
  };

  it("never requests a site its terms forbid, even behind a redirect", async () => {
    const server = fakeServer({
      [`${BASE}/notice/doc`]: answer(null, { Location: "https://platformazakupowa.pl/transakcja/1375199" }, 302),
      "https://platformazakupowa.pl/transakcja/1375199": answer(PDF, { "Content-Type": "application/pdf" }),
    });
    const { guard, asked } = guardFor({ "platformazakupowa.pl": "terms" });
    expect(await fetchDocument(`${BASE}/notice/doc`, { fetch: server.fetch, guard })).toEqual({
      kind: "blocked",
      finalUrl: "https://platformazakupowa.pl/transakcja/1375199",
      reason: "terms",
    });
    expect(server.requests.map((r) => r.url)).toEqual([`${BASE}/notice/doc`]);
    expect(asked).toEqual([`${BASE}/notice/doc`, "https://platformazakupowa.pl/transakcja/1375199"]);
  });

  it("sends nothing when the first address is turned down, and passes the reason on", async () => {
    for (const reason of ["robots", "robots_unavailable"] as const) {
      const { result, requests } = await fetchOne(answer(PDF), undefined, { guard: guardFor({ "ihale.example.gov": reason }).guard });
      expect(result).toEqual({ kind: "blocked", finalUrl: `${BASE}/download/spec.pdf`, reason });
      expect(requests).toEqual([]);
    }
  });

  it("asks before every hop on the same site too", async () => {
    const server = fakeServer({
      [`${BASE}/a`]: answer(null, { Location: "/b" }, 301),
      [`${BASE}/b`]: answer(null, { Location: "/c.pdf" }, 302),
      [`${BASE}/c.pdf`]: answer(PDF, { "Content-Type": "application/pdf" }),
    });
    const { guard, asked } = guardFor({});
    expect(await fetchDocument(`${BASE}/a`, { fetch: server.fetch, guard })).toMatchObject({ kind: "file", finalUrl: `${BASE}/c.pdf` });
    expect(asked).toEqual([`${BASE}/a`, `${BASE}/b`, `${BASE}/c.pdf`]);
  });

  it("refuses a local address before asking the guard", async () => {
    const { guard, asked } = guardFor({});
    const server = fakeServer({});
    expect(await fetchDocument("http://10.0.0.5/spec.pdf", { fetch: server.fetch, guard })).toMatchObject({ kind: "failed", retryable: false });
    expect(asked).toEqual([]);
  });

  it("fails, to be tried again, when the guard cannot tell", async () => {
    const { result, requests } = await fetchOne(answer(PDF), undefined, {
      guard: async () => {
        throw new Error("database down");
      },
    });
    expect(result).toEqual({ kind: "failed", error: "Erişim kontrolü yapılamadı (database down).", status: null, retryable: true, retryAfterMs: null });
    expect(requests).toEqual([]);

    const stuck = await fetchOne(answer(PDF), undefined, { guard: () => new Promise(() => {}), timeoutMs: 30 });
    expect(stuck.result).toMatchObject({ kind: "failed", status: null, retryable: true, error: expect.stringContaining("Zaman aşımı") });
  });
});

describe("fetchDocument cookies", () => {
  const portalUrl = `${BASE}/transakcja/1375199`;
  /** A portal that sets a session cookie, sends the request round, and answers whoever brings PHPSESSID=abc. */
  const cookiePortal = (setCookie: string) =>
    fakeServer({
      [portalUrl]: (init) =>
        new Headers(init?.headers).get("cookie")?.includes("PHPSESSID=abc")
          ? new Response('<html><body><a href="/file/get_new/1.pdf">Pobierz</a></body></html>', { headers: { "Content-Type": "text/html" } })
          : new Response(null, { status: 302, headers: { Location: "/transakcja/1375199", "Set-Cookie": setCookie } }),
    });

  it("answers a cookie check as a browser would, when given a jar", async () => {
    const server = cookiePortal("PHPSESSID=abc; Path=/; HttpOnly");
    const result = await fetchDocument(portalUrl, { fetch: server.fetch, cookies: createCookieJar() });
    expect(result).toMatchObject({ kind: "page", finalUrl: portalUrl, login: false, html: expect.stringContaining("Pobierz") });
    expect(server.requests.map((r) => new Headers(r.init?.headers).get("cookie"))).toEqual([null, "PHPSESSID=abc"]);
  });

  it("sends no cookie without a jar, and stops when the same cookies come round again", async () => {
    const without = cookiePortal("PHPSESSID=abc; Path=/");
    expect(await fetchDocument(portalUrl, { fetch: without.fetch })).toMatchObject({ kind: "page", html: "" });
    expect(without.requests).toHaveLength(1);

    // A cookie the server never accepts: one more try with it, then a page.
    const stubborn = cookiePortal("other=1; Path=/");
    expect(await fetchDocument(portalUrl, { fetch: stubborn.fetch, cookies: createCookieJar() })).toMatchObject({ kind: "page", html: "" });
    expect(stubborn.requests).toHaveLength(2);
  });

  it("keeps the cookies a redirect sets, for the sites they belong to", async () => {
    const headers = new Headers({ Location: "https://docs.example.gov/view/1" });
    headers.append("Set-Cookie", "portal=1; Domain=example.gov; Path=/");
    headers.append("Set-Cookie", "elsewhere=1; Domain=other.example.org");
    const server = fakeServer({
      [`${BASE}/d/1`]: answer(null, headers, 302),
      "https://docs.example.gov/view/1": answer(PDF, { "Content-Type": "application/pdf" }),
    });
    expect(await fetchDocument(`${BASE}/d/1`, { fetch: server.fetch, cookies: createCookieJar() })).toMatchObject({ kind: "file" });
    expect(new Headers(server.requests[1]!.init?.headers).get("cookie")).toBe("portal=1");
  });
});

describe("createCookieJar", () => {
  it("sends host cookies to their host, domain cookies to subdomains too", () => {
    const jar = createCookieJar();
    jar.store("https://www.portal.example.gov/a/b", ["host=1", "wide=2; Domain=.portal.example.gov; Path=/"]);
    expect(jar.header("https://www.portal.example.gov/a/c")).toBe("host=1; wide=2");
    expect(jar.header("https://files.portal.example.gov/x")).toBe("wide=2");
    expect(jar.header("https://other.example.gov/x")).toBeNull();
  });

  it("keeps a cookie to its path, the request's folder by default, longer paths first", () => {
    const jar = createCookieJar();
    jar.store("https://p.example.gov/tender/17/view", ["folder=1", "root=2; Path=/", "docs=3; Path=/tender/17/docs"]);
    expect(jar.header("https://p.example.gov/tender/17/docs/a.pdf")).toBe("docs=3; folder=1; root=2");
    expect(jar.header("https://p.example.gov/tender/170")).toBe("root=2");
    expect(jar.header("https://p.example.gov/")).toBe("root=2");
  });

  it("sends Secure cookies over https only", () => {
    const jar = createCookieJar();
    jar.store("https://p.example.gov/", ["s=1; Secure", "plain=2"]);
    expect(jar.header("http://p.example.gov/")).toBe("plain=2");
    expect(jar.header("https://p.example.gov/")).toBe("s=1; plain=2");
  });

  it("forgets what expires, replaces in place, and refuses other sites' and whole-domain cookies", () => {
    let clock = Date.parse("2026-10-17T10:00:00Z");
    const jar = createCookieJar(() => clock);
    jar.store("https://p.example.gov/", ["a=1; Max-Age=60", "b=1", "c=1; Expires=Sat, 17 Oct 2026 09:00:00 GMT"]);
    expect(jar.header("https://p.example.gov/")).toBe("a=1; b=1");
    jar.store("https://p.example.gov/", ["b=2", "a=1; Max-Age=0"]);
    expect(jar.header("https://p.example.gov/")).toBe("b=2");
    jar.store("https://p.example.gov/", ["x=1; Max-Age=60"]);
    clock += 61_000;
    expect(jar.header("https://p.example.gov/")).toBe("b=2");
    jar.store("https://p.example.gov/", ["evil=1; Domain=example.org", "tld=1; Domain=gov", "=nameless", "broken"]);
    expect(jar.header("https://p.example.gov/")).toBe("b=2");
    expect(jar.header("https://www.example.org/")).toBeNull();
  });
});

describe("createHostThrottle", () => {
  it("spaces requests to one host and leaves other hosts alone", async () => {
    let clock = 0;
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
      clock += ms;
    };
    const throttle = createHostThrottle(2_000, sleep, () => clock);
    await throttle.wait("https://a.example/1.pdf");
    await throttle.wait("https://a.example/2.pdf");
    await throttle.wait("https://b.example/1.pdf");
    clock += 5_000;
    await throttle.wait("https://A.EXAMPLE./3.pdf");
    expect(delays).toEqual([2_000]);
  });

  it("queues calls made at once instead of starting them together", async () => {
    const delays: number[] = [];
    const throttle = createHostThrottle(undefined, async (ms) => {
      delays.push(ms);
    }, () => 0);
    const url = "https://a.example/spec.pdf";
    await Promise.all([throttle.wait(url), throttle.wait(url), throttle.wait(url)]);
    expect(delays).toEqual([DOCUMENT_LIMITS.hostIntervalMs, 2 * DOCUMENT_LIMITS.hostIntervalMs]);
  });
});
