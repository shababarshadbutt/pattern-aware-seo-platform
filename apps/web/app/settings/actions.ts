"use server";

import { revalidatePath } from "next/cache";

import { ApiError, patchSite, type SiteSummary } from "../../lib/api";
import {
  isEmptyPatch,
  SiteFormError,
  type SiteFormValues,
  type SitePatch,
  siteFormPatch
} from "../../lib/settings";

/**
 * Save a site's configuration.
 *
 * A SERVER ACTION, NOT A BROWSER FETCH, and the reason is not style. `WEB_API_URL`
 * is a server-only variable — it carries no `NEXT_PUBLIC_` prefix, so a client
 * component cannot read it and would have to hardcode an origin or have one
 * exposed publicly. Writing through the server keeps the API address on the
 * server, keeps the API the only writer, and means the browser never depends on
 * the API's currently wide-open `origin: true` CORS.
 *
 * It does NOT make the write authenticated. The endpoint accepts anyone who can
 * reach it (ADR-0026 defers auth); this only decides which process calls it.
 */
export interface SaveState {
  readonly status: "idle" | "saved" | "error" | "unchanged";
  readonly message?: string;
}

export async function saveSiteSettings(
  current: SiteSummary,
  _previous: SaveState,
  formData: FormData
): Promise<SaveState> {
  const values: SiteFormValues = {
    name: String(formData.get("name") ?? ""),
    baseUrl: String(formData.get("baseUrl") ?? ""),
    tier: String(formData.get("tier") ?? current.tier),
    // An unchecked checkbox sends NOTHING, so absence is false rather than
    // unchanged — which is why the field is read this way and not with `??`.
    isActive: formData.get("isActive") !== null,
    dailyRequestCap: String(formData.get("dailyRequestCap") ?? ""),
    minRequestIntervalMs: String(formData.get("minRequestIntervalMs") ?? "")
  };

  let patch: SitePatch;

  try {
    patch = siteFormPatch(current, values);
  } catch (error) {
    if (error instanceof SiteFormError) {
      return { status: "error", message: error.message };
    }

    throw error;
  }

  if (isEmptyPatch(patch)) {
    // Said rather than silently reporting success: a form that claims it saved
    // when it sent nothing teaches the reader to distrust the next confirmation.
    return { status: "unchanged", message: "No changes to save." };
  }

  try {
    await patchSite(current.id, patch);
  } catch (error) {
    if (error instanceof ApiError) {
      /*
       * The API's 409s are the interesting ones and they are actionable, so
       * the message is shown as written: a host already monitored by another
       * site, or a tier change refused because a run is in flight.
       */
      return { status: "error", message: error.message };
    }

    throw error;
  }

  // Every settings screen is `force-dynamic`, but the site drill-down and the
  // fleet list read the same row, so they are revalidated too.
  revalidatePath("/settings");
  revalidatePath("/");
  revalidatePath(`/sites/${current.id}`);

  return { status: "saved", message: "Configuration saved." };
}
