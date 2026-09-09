"use client";

import Link from "next/link";
import { useActionState } from "react";

import { CrawlIcon } from "../../components/icons";
import { type RunState, startRunAction } from "./actions";

/**
 * The portfolio row's "Run now" quick action — the Stitch design's play
 * button, and the first thing on this screen that sends real HTTP traffic.
 *
 * A CLIENT COMPONENT, like {@link NewProjectForm}, for the same reason: a
 * click here has three outcomes a reader must be able to tell apart —
 * started, already running, or this deployment can't dispatch runs — and
 * reporting which one happened is not expressible in a Server Component or a
 * plain `<Link>`.
 *
 * Renders as an icon button rather than the row's `RowAction` `<Link>`
 * variant, because this one submits a form instead of navigating.
 */
export function RunNowAction({ siteId }: { readonly siteId: string }) {
  const [state, formAction, pending] = useActionState<RunState, FormData>(
    startRunAction,
    { status: "idle" }
  );

  return (
    <div className="relative">
      <form action={formAction}>
        <input name="siteId" type="hidden" value={siteId} />
        <button
          aria-label="Run now"
          className="flex h-7 w-7 items-center justify-center rounded-sm border border-border-subtle text-secondary transition-colors hover:border-border-strong hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={pending}
          title="Start a real audit against this site's own sitemap"
          type="submit"
        >
          <CrawlIcon className="h-4 w-4" />
        </button>
      </form>

      {state.status !== "idle" && state.message !== undefined && (
        <div
          className="absolute right-0 top-8 z-10 w-64 rounded-sm border border-border-subtle bg-surface-raised p-2 text-2xs shadow-lg"
          role="status"
        >
          <p
            style={{
              color:
                state.status === "error"
                  ? "var(--status-critical)"
                  : "var(--status-healthy)"
            }}
          >
            {state.status === "error" ? "Could not start: " : "Started: "}
            {state.message}
          </p>
          {state.status === "started" && state.runId !== undefined && (
            <Link
              className="text-accent-text hover:underline"
              href={`/runs/${state.runId}`}
            >
              View run progress
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
