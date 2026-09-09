/**
 * Inline error state for a failed server-side fetch to the API.
 *
 * Server components in this app fetch data directly (no client-side loading
 * spinner), so the only failure surface is "the fetch rejected" — most often
 * because `apps/api` is not running yet during manual testing. This renders
 * something actionable instead of the framework's generic error overlay.
 */
export function ApiErrorPanel({ message }: { readonly message: string }) {
  return (
    <div
      className="rounded-md border px-4 py-3 text-sm"
      style={{
        borderColor: "var(--status-critical)",
        color: "var(--status-critical)",
        backgroundColor:
          "color-mix(in oklab, var(--status-critical) 8%, transparent)"
      }}
    >
      <p className="font-medium">Could not load this screen.</p>
      <p className="mt-1 font-mono text-xs text-secondary">{message}</p>
    </div>
  );
}
