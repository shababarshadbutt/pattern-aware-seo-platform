import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { NotASitemapError, streamLocs } from "./loc-stream.js";
import { NON_XML_PREAMBLE_MESSAGE } from "./preamble.js";

function stream(content: string | Buffer): Readable {
  return Readable.from([
    Buffer.isBuffer(content) ? content : Buffer.from(content)
  ]);
}

function urlset(locs: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc><lastmod>2026-01-01</lastmod></url>`).join("\n")}
</urlset>`;
}

async function collect(
  content: string | Buffer,
  options: Parameters<typeof streamLocs>[2] = {}
): Promise<{ locs: string[]; ordinals: number[] }> {
  const locs: string[] = [];
  const ordinals: number[] = [];

  await streamLocs(
    stream(content),
    (loc, ordinal) => {
      locs.push(loc);
      ordinals.push(ordinal);
    },
    options
  );

  return { locs, ordinals };
}

describe("streamLocs", () => {
  it("emits every loc in document order with its ordinal", async () => {
    const { locs, ordinals } = await collect(
      urlset(["https://a.test/1", "https://a.test/2", "https://a.test/3"])
    );

    expect(locs).toEqual([
      "https://a.test/1",
      "https://a.test/2",
      "https://a.test/3"
    ]);
    // The ordinal is half of the (fileId, ordinal) address the sampler stores
    // instead of the URL, so it must be the position within this file.
    expect(ordinals).toEqual([0, 1, 2]);
  });

  it("reads gzip-encoded sitemaps", async () => {
    const { locs } = await collect(
      gzipSync(Buffer.from(urlset(["https://a.test/gz"]))),
      { isGzip: true }
    );

    expect(locs).toEqual(["https://a.test/gz"]);
  });

  it("handles namespace-prefixed elements", async () => {
    const { locs } = await collect(`<?xml version="1.0"?>
<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:url><sm:loc>https://a.test/prefixed</sm:loc></sm:url>
</sm:urlset>`);

    expect(locs).toEqual(["https://a.test/prefixed"]);
  });

  it("reads URLs wrapped in CDATA", async () => {
    const { locs } = await collect(`<?xml version="1.0"?>
<urlset>
  <url><loc><![CDATA[https://a.test/cdata?a=1&b=2]]></loc></url>
</urlset>`);

    expect(locs).toEqual(["https://a.test/cdata?a=1&b=2"]);
  });

  it("trims whitespace around a loc", async () => {
    const { locs } = await collect(`<urlset>
  <url><loc>
      https://a.test/padded
  </loc></url>
</urlset>`);

    expect(locs).toEqual(["https://a.test/padded"]);
  });

  describe("sitemap indexes", () => {
    const index = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://a.test/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://a.test/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;

    /**
     * Treating an index's children as page URLs would report a population of
     * two where the truth is millions — a silent, catastrophic undercount — so
     * the caller has to ask for them explicitly.
     */
    it("ignores index entries unless asked for them", async () => {
      const { locs } = await collect(index);

      expect(locs).toEqual([]);
    });

    it("returns child sitemap URLs when asked", async () => {
      const { locs } = await collect(index, { includeIndexLocs: true });

      expect(locs).toEqual([
        "https://a.test/sitemap-1.xml",
        "https://a.test/sitemap-2.xml"
      ]);
    });

    it("reports which kind of document it was", async () => {
      const asIndex = await streamLocs(stream(index), () => {}, {
        includeIndexLocs: true
      });
      const asUrlset = await streamLocs(
        stream(urlset(["https://a.test/1"])),
        () => {}
      );

      expect(asIndex.rootElement).toBe("sitemapindex");
      expect(asUrlset.rootElement).toBe("urlset");
    });
  });

  describe("recovering from junk before the XML", () => {
    // Misconfigured hosts routinely emit a warning or a BOM ahead of the
    // declaration. Rejecting the file would report a healthy sitemap as broken.
    it("strips a leading PHP warning", async () => {
      const { locs } = await collect(
        `Warning: include() failed in /var/www/index.php on line 3\n${urlset(["https://a.test/ok"])}`
      );

      expect(locs).toEqual(["https://a.test/ok"]);
    });

    it("strips a byte-order mark", async () => {
      const { locs } = await collect(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(urlset(["https://a.test/bom"]))
        ])
      );

      expect(locs).toEqual(["https://a.test/bom"]);
    });

    it("reports that recovery happened", async () => {
      const result = await streamLocs(
        stream(`junk\n${urlset(["https://a.test/x"])}`),
        () => {}
      );

      expect(result.hadPreambleStripped).toBe(true);
    });

    it("rejects a file with no markup at all", async () => {
      await expect(
        collect("this is a plain text file, not xml")
      ).rejects.toThrow(NON_XML_PREAMBLE_MESSAGE);
    });
  });

  describe("stopping early", () => {
    /**
     * How the oversize hard limit is enforced: a 200-million-URL sitemap costs
     * one truncated read rather than a complete one.
     */
    it("stops when the callback returns false", async () => {
      const seen: string[] = [];

      const result = await streamLocs(
        stream(
          urlset(Array.from({ length: 500 }, (_, i) => `https://a.test/${i}`))
        ),
        (loc) => {
          seen.push(loc);

          return seen.length < 10;
        }
      );

      expect(seen).toHaveLength(10);
      expect(result.stoppedEarly).toBe(true);
    });

    it("reports a complete read as not stopped early", async () => {
      const result = await streamLocs(
        stream(urlset(["https://a.test/1"])),
        () => true
      );

      expect(result.stoppedEarly).toBe(false);
      expect(result.locCount).toBe(1);
    });
  });

  describe("documents that parse but are not sitemaps", () => {
    /**
     * The subtle one. An HTML error page is often perfectly well-formed XML,
     * so it parses without complaint and yields no <loc> elements. Reported as
     * success it would record a population of zero for a site with millions of
     * URLs — indistinguishable downstream from a site that genuinely lists
     * nothing.
     */
    it("rejects an HTML error page served in place of a sitemap", async () => {
      await expect(
        collect(
          "<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>"
        )
      ).rejects.toThrow(NotASitemapError);
    });

    it("rejects a well-formed XML document with the wrong root", async () => {
      await expect(collect("<rss><channel></channel></rss>")).rejects.toThrow(
        NotASitemapError
      );
    });

    it("can be told to allow an unrecognised root", async () => {
      const result = await streamLocs(
        stream("<rss><channel></channel></rss>"),
        () => {},
        { requireSitemapRoot: false }
      );

      expect(result.rootElement).toBe("unknown");
      expect(result.locCount).toBe(0);
    });
  });

  it("rejects malformed XML rather than returning a partial answer", async () => {
    await expect(
      collect(
        `<?xml version="1.0"?><urlset><url><loc>https://a.test/1</loc></urlset>`
      )
    ).rejects.toThrow();
  });

  it("handles an empty urlset", async () => {
    const { locs } = await collect(urlset([]));

    expect(locs).toEqual([]);
  });

  /**
   * The property the whole design rests on: a sitemap is parsed in constant
   * memory, so file size does not translate into heap. Asserted by feeding
   * chunks through the stream rather than one big buffer.
   */
  it("parses without accumulating the document", async () => {
    const chunks: string[] = ['<?xml version="1.0"?>\n<urlset>\n'];

    for (let index = 0; index < 20_000; index += 1) {
      chunks.push(`<url><loc>https://a.test/p/${index}</loc></url>\n`);
    }

    chunks.push("</urlset>");

    let count = 0;
    const before = process.memoryUsage().heapUsed;

    await streamLocs(Readable.from(chunks.map((c) => Buffer.from(c))), () => {
      count += 1;
    });

    const growthMb = (process.memoryUsage().heapUsed - before) / 1_048_576;

    expect(count).toBe(20_000);
    // Generous, because a GC may not have run; the point is that it is not
    // proportional to the ~800 KB of document streamed through.
    expect(growthMb).toBeLessThan(40);
  });
});
