"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import {
  Button,
  Field,
  FieldRow,
  FieldStack,
  Select,
  TextInput
} from "../../components/form";
import { Panel } from "../../components/panel";
import { type CreateState, createProjectAction } from "./actions";

/**
 * The Stitch portfolio's "Add New Project" action, as a disclosed form.
 *
 * A CLIENT COMPONENT, like the settings form and for the same reason: it has
 * to report what happened. This is the API's first CREATE, and the two
 * outcomes a reader must be able to tell apart are "onboarded" and "that host
 * is already monitored" — neither is expressible in a Server Component.
 *
 * DISCLOSED RATHER THAN A MODAL. The design's button implies a dialog; this app
 * has no modal, no overlay and no focus-trap primitive, and building one to hold
 * three fields would add a whole interaction layer for one screen. DESIGN.md
 * allows radius `lg` for modals and popovers, so a modal is not forbidden — it
 * is simply not built, and a panel that expands in place is honest about that
 * rather than a half-modal that traps nothing.
 *
 * THE FIELDS ARE THE PRODUCT'S, NOT THE DESIGN'S (ADR-0031). There is no
 * environment picker because there is no environment column — `tier` is the
 * real thing that changes behaviour, since queues are namespaced
 * `{tier}:{siteId}:{stage}`. And there is no `host` field: the repository
 * derives it from the base URL so the bucket the outbound rate limiter
 * throttles on can never disagree with the URL actually requested.
 */
export function NewProjectForm() {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(
    createProjectAction,
    { status: "idle" }
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="primary">
        + Add new project
      </Button>
    );
  }

  return (
    <div className="w-full min-w-[320px] max-w-[560px]">
      <Panel title="Add a project">
        <form action={formAction}>
          <FieldStack>
            <Field
              htmlFor="name"
              label="project name"
              hint="What this appears as in the portfolio and the rail's breadcrumbs."
            >
              <TextInput id="name" name="name" placeholder="Acme Storefront" />
            </Field>

            <FieldRow>
              <Field
                htmlFor="baseUrl"
                label="base url"
                hint="The host is derived from this, so the rate limiter can never throttle a different origin from the one requested."
              >
                <TextInput
                  id="baseUrl"
                  inputMode="url"
                  name="baseUrl"
                  placeholder="https://www.example.com"
                />
              </Field>
              <Field
                htmlFor="tier"
                label="tier"
                hint="Decides the queue namespace the site's work runs under. Changing it later is refused while a run is in flight."
              >
                <Select
                  defaultValue="standard"
                  id="tier"
                  name="tier"
                  options={[
                    { value: "standard", label: "standard" },
                    { value: "priority", label: "priority" },
                    { value: "bulk", label: "bulk" }
                  ]}
                />
              </Field>
            </FieldRow>

            {/*
              Said as a word and not only through colour, and never as a bare
              "saved" — the settings form's rule. A create that reports success
              without naming what it created teaches the reader to distrust the
              next confirmation.
            */}
            {state.status !== "idle" && state.message !== undefined && (
              <p
                className="text-sm"
                style={{
                  color:
                    state.status === "error"
                      ? "var(--status-critical)"
                      : "var(--status-healthy)"
                }}
              >
                {state.status === "error" ? "Could not add: " : "Added: "}
                {state.message}
                {state.status === "created" && state.siteId !== undefined && (
                  <>
                    {" "}
                    <Link
                      className="text-accent-text hover:underline"
                      href={`/settings?site=${state.siteId}`}
                    >
                      Configure it
                    </Link>
                    .
                  </>
                )}
              </p>
            )}

            <p className="text-2xs leading-relaxed text-tertiary">
              Onboarding creates this site&rsquo;s table partitions, in the same
              transaction as the row. Nothing starts running: there is no
              scheduler and no way to trigger a run from this interface, so the
              project sits at <span className="font-mono">never run</span> until
              a worker picks it up.
            </p>

            <div className="flex items-center justify-end gap-3">
              <Button onClick={() => setOpen(false)} type="button">
                Cancel
              </Button>
              <Button disabled={pending} type="submit" variant="primary">
                {pending ? "Adding…" : "Add project"}
              </Button>
            </div>
          </FieldStack>
        </form>
      </Panel>
    </div>
  );
}
