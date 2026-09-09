"use server";

import { revalidatePath } from "next/cache";

import { ApiError, createProject, startRun } from "../../lib/api";
import {
  NewProjectError,
  type NewProjectInput,
  newProjectInput
} from "../../lib/projects";

/**
 * Onboard a project.
 *
 * A SERVER ACTION, NOT A BROWSER FETCH, for the reason `saveSiteSettings` is:
 * `WEB_API_URL` carries no `NEXT_PUBLIC_` prefix, so a client component cannot
 * read it and would have to hardcode an origin or have one published. Writing
 * through the server keeps the API address on the server and keeps the browser
 * off the API entirely.
 *
 * It does NOT make the write authenticated. The endpoint accepts anyone who can
 * reach it (ADR-0026 defers auth), and onboarding a site creates partitions —
 * this only decides which process calls it.
 */
export interface CreateState {
  readonly status: "idle" | "created" | "error";
  readonly message?: string;
  /** The new site, so the form can offer a link straight to its settings. */
  readonly siteId?: string;
}

export async function createProjectAction(
  _previous: CreateState,
  formData: FormData
): Promise<CreateState> {
  let input: NewProjectInput;

  /*
   * Validated through `lib/projects.ts` rather than here. A `"use server"`
   * module cannot be unit-tested without standing up `next/cache`, so
   * validation written inline would be validation nothing checks — the same
   * reason `saveSiteSettings` calls `siteFormPatch`.
   */
  try {
    input = newProjectInput({
      name: String(formData.get("name") ?? ""),
      baseUrl: String(formData.get("baseUrl") ?? ""),
      tier: String(formData.get("tier") ?? "standard")
    });
  } catch (error) {
    if (error instanceof NewProjectError) {
      return { status: "error", message: error.message };
    }

    throw error;
  }

  try {
    const site = await createProject(input);

    /*
     * Every screen that reads the site list. The portfolio is `force-dynamic`,
     * but Overview and the settings selector read the same rows and would
     * otherwise not show the new project until something else invalidated them.
     */
    revalidatePath("/projects");
    revalidatePath("/");
    revalidatePath("/settings");

    return {
      status: "created",
      message: `${site.name} is now monitored at ${site.host}.`,
      siteId: site.id
    };
  } catch (error) {
    if (error instanceof ApiError) {
      /*
       * The API's own message, as written. Its 409 names the host already
       * monitored, which is the only part of the failure a reader can act on —
       * "could not create project" throws that away.
       */
      return { status: "error", message: error.message };
    }

    throw error;
  }
}

/**
 * Start a real audit against a project's own sitemap.
 *
 * A SERVER ACTION for the same reason `createProjectAction` is: `WEB_API_URL`
 * is server-only, and the two outcomes a reader must be able to tell apart —
 * "started" vs. "already running" vs. "this deployment can't dispatch runs" —
 * are not expressible from a plain `<Link>`.
 *
 * This sends real HTTP traffic at the site's host once the worker picks up
 * the attach request (see `apps/api/src/routes/sites.ts`'s
 * `POST /sites/:siteId/runs`). It does not make the write authenticated —
 * ADR-0026 still defers auth — it only decides which process calls it.
 */
export interface RunState {
  readonly status: "idle" | "started" | "error";
  readonly message?: string;
  /** The started run, so the caller can link straight to its progress. */
  readonly runId?: string;
}

export async function startRunAction(
  _previous: RunState,
  formData: FormData
): Promise<RunState> {
  const siteId = String(formData.get("siteId") ?? "");

  try {
    const run = await startRun(siteId);

    // The portfolio's status column and Overview both read the site's
    // latest run, so both need to reflect "running" immediately rather than
    // waiting for whatever next navigates there.
    revalidatePath("/projects");
    revalidatePath("/");

    return {
      status: "started",
      message: `Run ${run.id.slice(0, 8)} is now running.`,
      runId: run.id
    };
  } catch (error) {
    if (error instanceof ApiError) {
      /*
       * The API's own message, as written — a 409 names the run already in
       * flight, a 503 says this deployment has no Redis configured, and
       * "could not start" would throw both away.
       */
      return { status: "error", message: error.message };
    }

    throw error;
  }
}
