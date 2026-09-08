"use client";

import { useActionState, useState } from "react";

import {
  Button,
  CheckboxRow,
  Field,
  FieldDivider,
  FieldRow,
  FieldStack,
  Select,
  TextInput
} from "../../components/form";
import { Panel } from "../../components/panel";
import type { PolicyLimit, SiteSummary } from "../../lib/api";
import { formatPolicyValue } from "../../lib/settings";
import { type SaveState, saveSiteSettings } from "./actions";

/**
 * The Stitch design's "Target Configuration" card.
 *
 * ONLY THE SECOND CLIENT COMPONENT IN THIS APP — the rail is the first, and it
 * is one purely to read the pathname. This one has to be: a form needs to
 * report a save result and reset itself on Discard, and neither is expressible
 * in a Server Component.
 *
 * THE FIELDS ARE NOT THE DESIGN'S FIELDS, deliberately (ADR-0031). Stitch shows
 * crawl frequency, crawl depth, a robots.txt toggle and a Puppeteer toggle;
 * this platform has no scheduler, no link graph to have a depth over, no
 * robots.txt handling and no headless browser, so rendering those would be four
 * controls claiming capabilities that do not exist. The card's structure,
 * spacing, label treatment and button placement are the design's; the controls
 * are this product's real per-site columns.
 *
 * `key` on the form is how Discard works: bumping it remounts the inputs, which
 * resets every `defaultValue` back to the server's row without tracking each
 * field in state. Uncontrolled inputs are the point — the server row is the
 * source of truth, and the patch is computed from it at submit.
 */
export function SiteForm({
  site,
  platformCap
}: {
  readonly site: SiteSummary;
  /** The limit an empty cap inherits, so the hint can name the real figure. */
  readonly platformCap?: PolicyLimit | undefined;
}) {
  const [state, formAction, pending] = useActionState<SaveState, FormData>(
    saveSiteSettings.bind(null, site),
    { status: "idle" }
  );
  const [formKey, setFormKey] = useState(0);

  const inheritHint =
    platformCap === undefined
      ? "Leave blank to inherit the platform default."
      : `Leave blank to inherit ${formatPolicyValue(platformCap.value, platformCap.unit)}.`;

  return (
    <form action={formAction} key={formKey}>
      <Panel
        title="Target Configuration"
        footer={
          <>
            {/*
              The result, next to the buttons that caused it. "unchanged" is its
              own state rather than a success: a form that says it saved when it
              sent nothing teaches the reader to distrust the next confirmation.
            */}
            {state.message !== undefined && (
              <p
                className={`mr-auto text-xs ${
                  state.status === "error"
                    ? "text-critical"
                    : state.status === "saved"
                      ? "text-healthy"
                      : "text-tertiary"
                }`}
                role="status"
              >
                {state.message}
              </p>
            )}
            <Button
              disabled={pending}
              onClick={() => {
                setFormKey((key) => key + 1);
              }}
              type="button"
              variant="ghost"
            >
              Discard Changes
            </Button>
            <Button disabled={pending} type="submit" variant="primary">
              {pending ? "Saving…" : "Save Configuration"}
            </Button>
          </>
        }
      >
        <FieldStack>
          <Field htmlFor="name" label="Project Name">
            <TextInput defaultValue={site.name} id="name" name="name" />
          </Field>

          <Field
            htmlFor="baseUrl"
            hint="The host the rate limiter buckets on is derived from this, so changing it re-points where probes are paced."
            label="Primary Domain"
          >
            <TextInput
              defaultValue={site.baseUrl}
              id="baseUrl"
              inputMode="url"
              name="baseUrl"
            />
          </Field>

          <FieldRow>
            <Field
              htmlFor="tier"
              hint="Queues are namespaced by tier. A change is refused while a run is in flight."
              label="Scheduling Tier"
            >
              <Select
                defaultValue={site.tier}
                id="tier"
                name="tier"
                options={[
                  { value: "standard", label: "Standard" },
                  { value: "priority", label: "Priority" },
                  { value: "bulk", label: "Bulk" }
                ]}
              />
            </Field>

            <Field
              htmlFor="dailyRequestCap"
              hint={inheritHint}
              label="Daily Request Cap"
            >
              <TextInput
                defaultValue={
                  site.dailyRequestCap === null
                    ? ""
                    : String(site.dailyRequestCap)
                }
                id="dailyRequestCap"
                inputMode="numeric"
                name="dailyRequestCap"
                placeholder="inherit"
              />
            </Field>
          </FieldRow>

          <Field
            htmlFor="minRequestIntervalMs"
            hint="Milliseconds between requests to this host — where a robots.txt Crawl-delay would land. Blank uses the tier default."
            label="Minimum Request Interval"
          >
            <TextInput
              defaultValue={
                site.minRequestIntervalMs === null
                  ? ""
                  : String(site.minRequestIntervalMs)
              }
              id="minRequestIntervalMs"
              inputMode="numeric"
              name="minRequestIntervalMs"
              placeholder="tier default"
            />
          </Field>
        </FieldStack>

        <FieldDivider />

        <CheckboxRow
          defaultChecked={site.isActive}
          id="isActive"
          label="Site is active (included in fleet reads and scheduling)"
          name="isActive"
        />
        <p className="mt-3 text-2xs text-warning">
          Neither the daily cap nor the minimum interval is enforced yet — see
          the Platform limits tab. Saving records the intent; nothing applies
          it.
        </p>
      </Panel>
    </form>
  );
}
