import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCUMENT_USER_AGENT } from "./limits";
import { createRobots, decodeEntities, extractDocumentLinks, MAX_PAGE_LINKS, robotsAllow, robotsRules } from "./portal";

const page = (name: string) => readFileSync(new URL(`../../tests/fixtures/documents/portals/${name}.html`, import.meta.url), "utf8");

describe("robotsRules and robotsAllow", () => {
  const allowed = (text: string, path: string) => robotsAllow(robotsRules(text), path);

  it("follows the group that names us, else the * group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: BozkorTenderBot/0.1\nDisallow: /private/\n";
    expect(allowed(text, "/tender/17")).toBe(true);
    expect(allowed(text, "/private/x")).toBe(false);
    expect(allowed("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /search\n", "/search?q=1")).toBe(false);
    expect(allowed("User-agent: Googlebot\nDisallow: /\n", "/anything")).toBe(true);
  });

  it("names us case-insensitively, and merges every group that does", () => {
    const text = "User-agent: bozkortenderbot\nDisallow: /a\n\nUser-agent: Other\nUser-agent: BOZKORTENDERBOT\nDisallow: /b\n";
    expect([allowed(text, "/a"), allowed(text, "/b"), allowed(text, "/c")]).toEqual([false, false, true]);
  });

  it("lets the longest matching rule decide, allow on a tie", () => {
    const text = "User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\nDisallow: /docs/public/drafts\nAllow: /x\nDisallow: /x\n";
    expect(allowed(text, "/docs/secret.pdf")).toBe(false);
    expect(allowed(text, "/docs/public/spec.pdf")).toBe(true);
    expect(allowed(text, "/docs/public/drafts/1.pdf")).toBe(false);
    expect(allowed(text, "/x")).toBe(true);
  });

  it("reads * and $ in patterns", () => {
    const text = "User-agent: *\nDisallow: /*.php$\nDisallow: /tender/*/edit\n";
    expect(allowed(text, "/index.php")).toBe(false);
    expect(allowed(text, "/index.php?id=1")).toBe(true);
    expect(allowed(text, "/tender/17/edit")).toBe(false);
    expect(allowed(text, "/tender/17/view")).toBe(true);
  });

  it("ignores empty rules, comments, other keys and rules before any user agent", () => {
    const text = "Disallow: /\n# a comment\nUser-agent: * # everyone\nDisallow:\nCrawl-delay: 10\nSitemap: https://example.gov/sitemap.xml\n";
    expect(allowed(text, "/anything")).toBe(true);
  });

  it("compares paths percent-encoded", () => {
    expect(allowed("User-agent: *\nDisallow: /dokumenty/żądania\n", "/dokumenty/%C5%BC%C4%85dania/1")).toBe(false);
  });
});

/** Answers robots.txt requests from a table and records them. */
function robotsServer(answers: Record<string, () => Response | Promise<Response>>) {
  const requests: { url: string; userAgent: string | null }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer();
  };
  return { fetch, requests };
}

const text = (body: string, status = 200) => () => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

describe("createRobots", () => {
  it("reads robots.txt once per site and run, through the caller's host spacing", async () => {
    const server = robotsServer({ "https://portal.example.gov/robots.txt": text("User-agent: *\nDisallow: /admin\n") });
    const waited: string[] = [];
    const robots = createRobots({ fetch: server.fetch, wait: async (url) => void waited.push(url) });
    const answers = await Promise.all([
      robots.allowed("https://portal.example.gov/tender/1"),
      robots.allowed("https://portal.example.gov/admin/x"),
      robots.allowed("https://portal.example.gov/tender/2"),
    ]);
    expect(answers).toEqual([true, false, true]);
    expect(server.requests).toEqual([{ url: "https://portal.example.gov/robots.txt", userAgent: DOCUMENT_USER_AGENT }]);
    expect(waited).toEqual(["https://portal.example.gov/robots.txt"]);
  });

  it("allows everything without a robots.txt (4xx), nothing while it cannot be read", async () => {
    const cases: [string, () => Response | Promise<Response>, boolean][] = [
      ["missing", text("", 404), true],
      ["gone", text("", 410), true],
      ["forbidden", text("", 403), true],
      ["busy", text("", 429), false],
      ["broken", text("", 503), false],
      [
        "offline",
        () => {
          throw new TypeError("fetch failed");
        },
        false,
      ],
    ];
    for (const [name, answer, expected] of cases) {
      const server = robotsServer({ [`https://${name}.example.gov/robots.txt`]: answer });
      expect(await createRobots({ fetch: server.fetch }).allowed(`https://${name}.example.gov/tender/1`), name).toBe(expected);
    }
  });

  it("tells allowed, disallowed and unavailable apart", async () => {
    const server = robotsServer({
      "https://open.example.gov/robots.txt": text("", 404),
      "https://ruled.example.gov/robots.txt": text("User-agent: *\nDisallow: /private\n"),
      "https://busy.example.gov/robots.txt": text("", 429),
      "https://down.example.gov/robots.txt": text("", 502),
      "https://gone.example.gov/robots.txt": () => {
        throw new TypeError("fetch failed");
      },
    });
    const robots = createRobots({ fetch: server.fetch });
    expect(
      await Promise.all([
        robots.check("https://open.example.gov/x"),
        robots.check("https://ruled.example.gov/public"),
        robots.check("https://ruled.example.gov/private/1"),
        robots.check("https://busy.example.gov/x"),
        robots.check("https://down.example.gov/x"),
        robots.check("https://gone.example.gov/x"),
        robots.check("http://192.168.1.1/x"),
      ]),
    ).toEqual(["allowed", "allowed", "disallowed", "unavailable", "unavailable", "unavailable", "disallowed"]);
    expect(await robots.allowed("https://busy.example.gov/x")).toBe(false);
  });

  it("asks again a few minutes after robots.txt could not be read", async () => {
    let clock = 0;
    let up = false;
    const server = robotsServer({ "https://portal.example.gov/robots.txt": () => (up ? text("User-agent: *\nDisallow:\n")() : text("", 503)()) });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    expect(await robots.check("https://portal.example.gov/a")).toBe("unavailable");
    clock += 4 * 60 * 1000;
    expect(await robots.check("https://portal.example.gov/b")).toBe("unavailable");
    expect(server.requests).toHaveLength(1);
    up = true;
    clock += 2 * 60 * 1000;
    expect(await robots.check("https://portal.example.gov/c")).toBe("allowed");
    expect(server.requests).toHaveLength(2);
    // Read now, so kept for a day.
    clock += 60 * 60 * 1000;
    expect(await robots.check("https://portal.example.gov/d")).toBe("allowed");
    expect(server.requests).toHaveLength(2);
  });

  it("gives up waiting for a robots.txt that does not come, and allows nothing", async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await createRobots({ fetch: hanging, timeoutMs: 20 }).allowed("https://slow.example.gov/x")).toBe(false);
  });

  it("follows up to five redirects, and treats more as no robots.txt", async () => {
    const moved = robotsServer({
      "https://a.example.gov/robots.txt": () => new Response(null, { status: 301, headers: { Location: "https://www.a.example.gov/robots.txt" } }),
      "https://www.a.example.gov/robots.txt": text("User-agent: *\nDisallow: /\n"),
    });
    expect(await createRobots({ fetch: moved.fetch }).allowed("https://a.example.gov/x")).toBe(false);

    const endless = robotsServer(
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `https://b.example.gov/robots${i ? i : ""}.txt`.replace("robots0", "robots"),
          () => new Response(null, { status: 302, headers: { Location: `/robots${i + 1}.txt` } }),
        ]),
      ),
    );
    expect(await createRobots({ fetch: endless.fetch }).allowed("https://b.example.gov/x")).toBe(true);
    expect(endless.requests).toHaveLength(6);
  });

  it("does not follow robots.txt to a portal whose terms forbid automated access, and keeps out the site that leads there", async () => {
    let clock = 0;
    const server = robotsServer({
      "https://zamowienia.example.pl/robots.txt": () =>
        new Response(null, { status: 301, headers: { Location: "https://platformazakupowa.pl/robots.txt" } }),
    });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    // Most likely the portal's tenant or copy, under its terms: every path is disallowed.
    expect(await robots.check("https://zamowienia.example.pl/tender/1")).toBe("disallowed");
    expect(await robots.check("https://zamowienia.example.pl/")).toBe("disallowed");
    expect(server.requests.map((r) => r.url)).toEqual(["https://zamowienia.example.pl/robots.txt"]);

    // Kept for a day like any robots.txt read, then asked again.
    clock += 23 * 60 * 60 * 1000;
    expect(await robots.check("https://zamowienia.example.pl/tender/2")).toBe("disallowed");
    expect(server.requests).toHaveLength(1);
    clock += 2 * 60 * 60 * 1000;
    expect(await robots.check("https://zamowienia.example.pl/tender/3")).toBe("disallowed");
    expect(server.requests).toHaveLength(2);

    // The portal itself is never asked either.
    expect(await robots.check("https://platformazakupowa.pl/transakcja/1")).toBe("disallowed");
    expect(server.requests.some((r) => r.url.includes("platformazakupowa.pl"))).toBe(false);
  });

  it("asks nothing for local addresses, and always allows robots.txt itself", async () => {
    const server = robotsServer({});
    const robots = createRobots({ fetch: server.fetch });
    expect(await robots.allowed("http://127.0.0.1/x")).toBe(false);
    expect(await robots.allowed("https://portal.example.gov/robots.txt")).toBe(true);
    expect(server.requests).toEqual([]);
  });

  it("reads robots.txt again after a day", async () => {
    let clock = 0;
    const server = robotsServer({ "https://portal.example.gov/robots.txt": text("User-agent: *\nDisallow:\n") });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    await robots.allowed("https://portal.example.gov/a");
    clock += 23 * 60 * 60 * 1000;
    await robots.allowed("https://portal.example.gov/b");
    clock += 2 * 60 * 60 * 1000;
    await robots.allowed("https://portal.example.gov/c");
    expect(server.requests).toHaveLength(2);
  });

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("keeps to the copy last read while the server or the network fails, asking again minutes later", async () => {
    let clock = 0;
    let answer: (init?: RequestInit) => Response | Promise<Response> = text("User-agent: *\nDisallow: /private\n");
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(String(input));
      return answer(init);
    };
    const robots = createRobots({ fetch, now: () => clock, timeoutMs: 20 });
    expect(await robots.check("https://portal.example.gov/public")).toBe("allowed");

    // A day later the server fails (RFC 9309 2.4): the copy read stands, its allows and its disallows.
    clock += 25 * HOUR;
    answer = text("", 503);
    expect(await robots.check("https://portal.example.gov/public")).toBe("allowed");
    expect(await robots.check("https://portal.example.gov/private/1")).toBe("disallowed");
    expect(requests).toHaveLength(2);

    // Asked again after a few minutes; offline or silent, the copy still stands.
    clock += 4 * MINUTE;
    expect(await robots.check("https://portal.example.gov/x")).toBe("allowed");
    expect(requests).toHaveLength(2);
    clock += 2 * MINUTE;
    answer = () => {
      throw new TypeError("fetch failed");
    };
    expect(await robots.check("https://portal.example.gov/private/2")).toBe("disallowed");
    expect(requests).toHaveLength(3);
    clock += 6 * MINUTE;
    answer = (init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    expect(await robots.check("https://portal.example.gov/public")).toBe("allowed");
    expect(requests).toHaveLength(4);

    // Read again: its new rules decide, for a day.
    clock += 6 * MINUTE;
    answer = text("User-agent: *\nDisallow: /public\n");
    expect(await robots.check("https://portal.example.gov/public")).toBe("disallowed");
    expect(await robots.check("https://portal.example.gov/private/1")).toBe("allowed");
    expect(requests).toHaveLength(5);
    clock += 23 * HOUR;
    expect(await robots.check("https://portal.example.gov/public")).toBe("disallowed");
    expect(requests).toHaveLength(5);
  });

  it("allows nothing while robots.txt answers 429, whatever was read before, and asks again minutes later", async () => {
    let clock = 0;
    let busy = false;
    const tooMany = () => new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
    const server = robotsServer({
      "https://portal.example.gov/robots.txt": () => (busy ? tooMany() : text("User-agent: *\nDisallow: /private\n")()),
      "https://open.example.gov/robots.txt": () => (busy ? tooMany() : text("", 404)()),
    });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    expect(await robots.check("https://portal.example.gov/public")).toBe("allowed");
    expect(await robots.check("https://open.example.gov/public")).toBe("allowed");

    // A 429 asks us to wait: neither the rules nor the "no robots.txt" read before stand in.
    busy = true;
    clock += 25 * HOUR;
    expect(await robots.check("https://portal.example.gov/public")).toBe("unavailable");
    expect(await robots.check("https://open.example.gov/public")).toBe("unavailable");
    expect(server.requests).toHaveLength(4);
    clock += 4 * MINUTE;
    expect(await robots.check("https://portal.example.gov/public")).toBe("unavailable");
    expect(server.requests).toHaveLength(4);

    busy = false;
    clock += 2 * MINUTE;
    expect(await robots.check("https://portal.example.gov/public")).toBe("allowed");
    expect(await robots.check("https://portal.example.gov/private/1")).toBe("disallowed");
    expect(server.requests).toHaveLength(5);
  });

  it("does not let the copy stand in when robots.txt now leads to an address it does not ask, or nowhere", async () => {
    let clock = 0;
    let location: string | null = null;
    const server = robotsServer({
      "https://portal.example.gov/robots.txt": () =>
        location === null ? text("User-agent: *\nDisallow:\n")() : new Response(null, { status: 301, headers: { Location: location } }),
    });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    expect(await robots.check("https://portal.example.gov/a")).toBe("allowed");
    clock += 25 * HOUR;
    location = "http://127.0.0.1/robots.txt";
    expect(await robots.check("https://portal.example.gov/b")).toBe("unavailable");
    clock += 6 * MINUTE;
    location = "http://[";
    expect(await robots.check("https://portal.example.gov/c")).toBe("unavailable");
    expect(server.requests.map((r) => r.url)).toEqual(Array(3).fill("https://portal.example.gov/robots.txt"));
  });

  it("allows nothing where no copy was read, or the copy is over 30 days old", async () => {
    let clock = 0;
    let up = true;
    const server = robotsServer({
      "https://portal.example.gov/robots.txt": () => (up ? text("User-agent: *\nDisallow:\n") : text("", 503))(),
      "https://open.example.gov/robots.txt": () => (up ? text("", 404) : text("", 503))(),
      "https://other.example.gov/robots.txt": text("", 503),
    });
    const robots = createRobots({ fetch: server.fetch, now: () => clock });
    expect(await robots.check("https://portal.example.gov/a")).toBe("allowed");
    expect(await robots.check("https://open.example.gov/a")).toBe("allowed");
    // Never read: another site's copy does not stand in.
    expect(await robots.check("https://other.example.gov/a")).toBe("unavailable");

    up = false;
    clock += 29 * DAY;
    // No robots.txt (4xx) was a reading too: it still allows everything.
    expect(await robots.check("https://portal.example.gov/b")).toBe("allowed");
    expect(await robots.check("https://open.example.gov/b")).toBe("allowed");
    expect(await robots.check("https://other.example.gov/b")).toBe("unavailable");

    clock += DAY + 6 * MINUTE;
    expect(await robots.check("https://portal.example.gov/c")).toBe("unavailable");
    expect(await robots.check("https://open.example.gov/c")).toBe("unavailable");

    // Read again, it decides once more.
    up = true;
    clock += 6 * MINUTE;
    expect(await robots.check("https://portal.example.gov/d")).toBe("allowed");
  });
});

describe("extractDocumentLinks on recorded portal pages", () => {
  it("takes every file of a cosinex documents page, and its ZIP of all", () => {
    const url = "https://ausschreibungen.giz.de/Satellite/public/company/project/CXTRYYRDY6BTG3FG/de/documents?0";
    const links = extractDocumentLinks(page("giz"), url);
    expect(links).toHaveLength(16);
    expect(links[0]).toEqual({
      url: "https://ausschreibungen.giz.de/Satellite/public/company/project/CXTRYYRDY6BTG3FG/de/documents/address/Bewerbungsbedingungen+VgV.pdf",
      text: "Die Datei herunterladen",
    });
    expect(links.at(-1)?.text).toBe("Alle Dokumente als ZIP-Datei herunterladen");
    // The page's own "Vergabeunterlagen" tab and the other tabs are no documents.
    expect(links.some((l) => /\/documents$|overview|communication/.test(l.url))).toBe(false);

    const nrw = extractDocumentLinks(page("evergabe-nrw"), "https://www.evergabe.nrw.de/VMPSatellite/public/company/project/CXS0YRDDY6GHT5X5/de/documents?0");
    expect(nrw.map((l) => l.text)).toEqual(["Alle Dokumente als ZIP-Datei herunterladen"]);
  });

  it("keeps the named documents when a page lists more than it takes, and none of the portal's menus", () => {
    const links = extractDocumentLinks(page("evergabe-online"), "https://www.evergabe-online.de/tenderdocuments.html?169&id=871102&cookieCheck");
    expect(links).toHaveLength(MAX_PAGE_LINKS);
    // Each document is listed by name and again as a nameless "Download" button; the names are kept.
    expect(links.every((l) => /^Tender documents\/Version \d\/\d\d /.test(l.text))).toBe(true);
    expect(links.some((l) => l.url.includes("/downloads/installer/"))).toBe(false);
    expect(links.some((l) => /forgotPassword|registration/.test(l.url))).toBe(false);
  });
});

describe("extractDocumentLinks", () => {
  const extract = (body: string, url = "https://www.portal.example.gov/tender/17") => extractDocumentLinks(`<html><body>${body}</body></html>`, url);

  it("resolves addresses against the page or its base, and decodes entities", () => {
    expect(extract('<a href="docs/a.pdf">A</a><a href="/get?file=b.xlsx&amp;v=2">B</a>')).toEqual([
      { url: "https://www.portal.example.gov/tender/docs/a.pdf", text: "A" },
      { url: "https://www.portal.example.gov/get?file=b.xlsx&v=2", text: "B" },
    ]);
    const based = extractDocumentLinks('<head><base href="/files/17/"><base-search-input href="/x/"></head><a href="c.zip">C</a>', "https://www.portal.example.gov/t/17");
    expect(based.map((l) => l.url)).toEqual(["https://www.portal.example.gov/files/17/c.zip"]);
  });

  it("knows documents by extension, download words in many languages, download attributes and paths", () => {
    const links = extract(
      [
        '<a href="/x/1">Specifikace.DOCX</a>',
        '<a href="/x/2">Изтегли</a>',
        '<a href="/x/3">Κατέβασμα</a>',
        '<a href="/x/4">Stáhnout zadávací dokumentaci</a>',
        '<a href="/x/5">Hent fil</a>',
        '<a href="/x/6" download>Paket</a>',
        '<a href="/Notice/FileDownload.aspx?id=6">Annex</a>',
        '<a href="/api/datoteka/get?id=7">Razpisna dokumentacija</a>',
        '<a href="/x/8">Authentication</a>',
        '<a href="/x/9">Contact</a>',
        '<a href="/x/10">Plan.rar</a>',
      ].join(""),
    );
    expect(links.map((l) => l.url.replace("https://www.portal.example.gov", ""))).toEqual([
      "/x/1",
      "/x/2",
      "/x/3",
      "/x/4",
      "/x/5",
      "/x/6",
      "/Notice/FileDownload.aspx?id=6",
      "/api/datoteka/get?id=7",
      "/x/10",
    ]);
  });

  it("stays on the site and leaves out mail, script and anchor links, and the page itself", () => {
    const links = extract(
      [
        '<a href="https://files.portal.example.gov/a.pdf">sub</a>',
        '<a href="https://portal.example.gov/b.pdf">parent</a>',
        '<a href="https://other.example.org/c.pdf">elsewhere</a>',
        '<a href="mailto:a@portal.example.gov">mail.pdf</a>',
        '<a href="javascript:download(1)">Download</a>',
        '<a href="#documents">Download</a>',
        '<a href="/tender/17#top">Download</a>',
      ].join(""),
    );
    expect(links.map((l) => l.text)).toEqual(["sub", "parent"]);
  });

  it("reads data-href with the element's text, and skips scripts and comments", () => {
    const links = extract(
      '<table><tr data-href="/Attachment/991"><td>Annex 1</td></tr></table><a href="javascript:;" data-href="/Attachment/992">Annex 2</a>' +
        "<script>document.write('<a href=\"/s.pdf\">s</a>')</script><!-- <a href=\"/c.pdf\">c</a> -->",
    );
    expect(links).toEqual([
      { url: "https://www.portal.example.gov/Attachment/991", text: "Annex 1" },
      { url: "https://www.portal.example.gov/Attachment/992", text: "Annex 2" },
    ]);
  });

  it("counts a link to the page's own path only by its name, not its path", () => {
    const url = "https://www.portal.example.gov/tenderdocuments.html?id=5";
    const links = extractDocumentLinks(
      '<a href="tenderdocuments.html?id=5&tab=2">Forgot password</a><a href="tenderdocuments.html?id=5&dl=1">Download</a><a href="documents/list">More</a>',
      url,
    );
    expect(links.map((l) => l.text)).toEqual(["Download", "More"]);
  });

  it("lists each document once, in page order, at most MAX_PAGE_LINKS", () => {
    const many = Array.from({ length: 40 }, (_, i) => `<a href="/download/${i}">Download ${i}</a>`).join("");
    const links = extract(`${many}<a href="/files/z.pdf">Z</a><a href="/download/1#again">again</a>`);
    expect(links).toHaveLength(MAX_PAGE_LINKS);
    // The PDF is surer than the rest, so it is kept, and stays where the page has it: last.
    expect(links.at(-1)).toEqual({ url: "https://www.portal.example.gov/files/z.pdf", text: "Z" });
    expect(new Set(links.map((l) => l.url)).size).toBe(MAX_PAGE_LINKS);
  });
});

describe("decodeEntities", () => {
  it("writes out named and numeric references, and leaves unknown ones", () => {
    expect(decodeEntities("T&eacute;l&eacute;charger &amp; &#246;&#x15f; &times; &unknown; &#0;")).toBe("Télécharger & öş × &unknown; &#0;");
  });
});
