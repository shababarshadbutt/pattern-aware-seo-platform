import { apiFetchInit, apiUrl } from "../../../../lib/api";

/**
 * Proxies the API's CSV export to the browser.
 *
 * WHY A PROXY RATHER THAN A DIRECT LINK. `WEB_API_URL` carries no
 * `NEXT_PUBLIC_` prefix, so it is server-only — a link in the page cannot
 * address the API without either hardcoding an origin or publishing one. The
 * same reasoning that put the settings save behind a Server Action puts this
 * behind a route handler: the API's address stays on the server, and the
 * browser talks only to Next.
 *
 * The body is PIPED, not buffered. The API streams its rows a page at a time
 * precisely so no process holds the whole file, and reading it into a string
 * here to hand it on would undo that at the last step.
 */
export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly runId: string }> }
): Promise<Response> {
  const { runId } = await context.params;

  const upstream = await fetch(
    `${apiUrl()}/runs/${encodeURIComponent(runId)}/export.csv`,
    apiFetchInit({ cache: "no-store" })
  );

  if (!upstream.ok || upstream.body === null) {
    /*
     * The upstream status is passed through rather than flattened to 500: a
     * 404 for a run in another organization must not read as a broken export.
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
        `attachment; filename="run-${runId}-observations.csv"`,
      "cache-control": "no-store"
    }
  });
}
