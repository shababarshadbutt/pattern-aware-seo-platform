import {
  apiFetchInit,
  apiUrl,
  projectsSearch,
  type SiteTier
} from "../../../lib/api";

/**
 * Proxies the API's portfolio CSV to the browser.
 *
 * WHY A PROXY RATHER THAN A DIRECT LINK, same as the run export: `WEB_API_URL`
 * carries no `NEXT_PUBLIC_` prefix, so it is server-only and a link in the page
 * cannot address the API without hardcoding or publishing an origin. The body
 * is PIPED rather than buffered, so the API's paging survives the last hop.
 *
 * THE FILTERS ARE FORWARDED BUT THE PAGE WINDOW IS NOT, and that asymmetry is
 * deliberate. A reader who filtered to `priority` and exported expects those
 * projects; a reader on page 2 who exported does not expect twenty-five rows
 * starting at twenty-six — they expect the portfolio. The API ignores `limit`
 * and `offset` for the export for the same reason: a file named "portfolio"
 * containing one page is a truncated export presented as a complete one.
 */
function tierOf(value: string | null): SiteTier | undefined {
  return value === "standard" || value === "priority" || value === "bulk"
    ? value
    : undefined;
}

export async function GET(request: Request): Promise<Response> {
  const incoming = new URL(request.url).searchParams;
  const tier = tierOf(incoming.get("tier"));

  const search = projectsSearch({
    ...(tier === undefined ? {} : { tier }),
    includeInactive: incoming.get("inactive") === "true"
  });

  const upstream = await fetch(
    `${apiUrl()}/projects/export.csv${search === "" ? "" : `?${search}`}`,
    apiFetchInit({ cache: "no-store" })
  );

  if (!upstream.ok || upstream.body === null) {
    /*
     * The upstream status is passed through rather than flattened to 500, so a
     * misconfigured organization (503) does not read as a broken export.
     */
    return new Response("Export unavailable.", {
      status: upstream.status === 200 ? 502 : upstream.status
    });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ??
        'attachment; filename="projects-portfolio.csv"',
      "cache-control": "no-store"
    }
  });
}
