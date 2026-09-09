"use server";

import { revalidatePath } from "next/cache";

import { ApiError, createProject } from "../../lib/api";
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
