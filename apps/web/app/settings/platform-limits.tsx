import { StatCards } from "../../components/stat-cards";
import { StatusBadge } from "../../components/status-badge";
import type { SettingsDetail, SiteSummary } from "../../lib/api";
import { formatCount } from "../../lib/format";
import {
  type Enforcement,
  policyRowsFrom,
  sitePolicyRowsFrom
} from "../../lib/settings";
import {
  enforcementTone,
  rowAccentStyle,
  siteActiveTone
} from "../../lib/status";

/**
 * The platform-policy tab.
 *
 * Kept from D3b rather than discarded in the Stitch rebuild, because it carries
 * a real finding: twelve of twenty-three configured limits are applied by
 * nothing. The Stitch design has no equivalent screen, so this lives as an
 * extra tab beside Project Core at the owner's direction (ADR-0031) rather than
 * as the whole of Settings, which is what it wrongly was.
 *
 * Everything here is read-only and has no per-site edit, so it is a Server
 * Component with no form.
 */

const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  in_force: "in force",
  not_enforced: "not enforced"
};

function EnforcementBadge({
  enforcement
}: {
  readonly enforcement: Enforcement;
}) {
  // Said as a word, never through hue alone (DESIGN.md section 8), and the tone
  // comes from lib/status.ts because the mapping is product logic.
  return (
    <StatusBadge
      label={ENFORCEMENT_LABEL[enforcement]}
      tone={enforcementTone(enforcement)}
    />
  );
}

const HEADER =
  "py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary";
const CELL = "py-3 pr-4 font-mono text-xs text-secondary";

export function PlatformLimits({
  settings,
  sites
}: {
  readonly settings: SettingsDetail;
  readonly sites: readonly SiteSummary[];
}) {
  const policyRows = policyRowsFrom(settings.policy);
  const siteRows = sitePolicyRowsFrom(
    sites,
    settings.siteColumns,
    settings.policy
  );
  const notEnforced = policyRows.filter(
    (row) => row.enforcement === "not_enforced"
  ).length;

  return (
    <>
      <p className="max-w-prose text-sm text-secondary">
        Validated at startup from the environment, and read-only: these change
        in the deployment, not on this page. Unenforced limits are listed first
        — a control that does nothing is the more useful thing to see.
      </p>

      <div className="mt-6">
        <StatCards
          stats={[
            { label: "sites", value: formatCount(sites.length) },
            {
              label: "active sites",
              value: formatCount(sites.filter((site) => site.isActive).length)
            },
            {
              label: "limits in force",
              value: formatCount(policyRows.length - notEnforced)
            },
            { label: "limits not enforced", value: formatCount(notEnforced) }
          ]}
        />
      </div>

      {notEnforced > 0 && (
        /*
          THE REASON THIS TAB SURVIVED THE REBUILD. Printing a "daily request
          cap" that nothing charges against would assert a guarantee the code
          does not make. The count comes from the API's manifest, which a test
          checks against the source tree in both directions, so this notice
          cannot outlive the gap it describes.
        */
        <p className="mt-4 max-w-prose text-xs text-warning">
          {formatCount(notEnforced)} of the {formatCount(policyRows.length)}{" "}
          limits below are configured but applied by nothing — the platform runs
          on its built-in defaults for these. Changing them in the environment
          currently has no effect.
        </p>
      )}

      <h2 className="mt-10 text-lg font-semibold tracking-tight">
        Platform limits
      </h2>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <caption className="sr-only">
            Platform operational limits and whether each is applied
          </caption>
          <thead>
            <tr className="border-b border-border-strong text-left">
              <th className={`${HEADER} pl-3`} scope="col">
                Variable
              </th>
              <th className={HEADER} scope="col">
                Limit
              </th>
              <th className={`${HEADER} text-right`} scope="col">
                Value
              </th>
              <th className={HEADER} scope="col">
                Enforcement
              </th>
              <th className={HEADER} scope="col">
                Applied at
              </th>
            </tr>
          </thead>
          <tbody>
            {policyRows.map((row) => (
              <tr
                className="border-b border-border-subtle transition-colors hover:bg-surface"
                key={row.key}
                style={rowAccentStyle(enforcementTone(row.enforcement))}
              >
                <th
                  className={`${CELL} pl-3 text-left font-normal`}
                  scope="row"
                >
                  {row.key}
                </th>
                <td className="py-3 pr-4 text-xs text-secondary">
                  {row.label}
                </td>
                <td
                  className={`${CELL} text-right tabular-nums text-primary`}
                  data-numeric
                >
                  {row.value}
                </td>
                <td className="py-3 pr-4">
                  <EnforcementBadge enforcement={row.enforcement} />
                </td>
                <td className={`${CELL} text-tertiary`}>{row.enforcedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-12 text-lg font-semibold tracking-tight">
        Per-site policy
      </h2>
      <p className="mt-1 max-w-prose text-sm text-secondary">
        Editable per project on the Project Core tab. Neither column reaches the
        code that issues requests, so both are recorded intent rather than an
        applied budget.
      </p>

      {siteRows.length === 0 ? (
        <p className="mt-4 text-sm text-secondary">
          No sites yet. Run <span className="font-mono">pnpm seed:demo</span> to
          create the demo organization.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <caption className="sr-only">
              Per-site request policy and whether it is applied
            </caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th className={`${HEADER} pl-3`} scope="col">
                  Site
                </th>
                <th className={HEADER} scope="col">
                  Host
                </th>
                <th className={HEADER} scope="col">
                  Tier
                </th>
                <th className={HEADER} scope="col">
                  Active
                </th>
                <th className={`${HEADER} text-right`} scope="col">
                  Daily cap
                </th>
                <th className={`${HEADER} text-right`} scope="col">
                  Min interval
                </th>
                <th className={HEADER} scope="col">
                  Enforcement
                </th>
              </tr>
            </thead>
            <tbody>
              {siteRows.map((row) => (
                <tr
                  className="border-b border-border-subtle transition-colors hover:bg-surface"
                  key={row.id}
                  style={rowAccentStyle(enforcementTone(row.enforcement))}
                >
                  <th
                    className="py-3 pr-4 pl-3 text-left text-sm font-normal"
                    scope="row"
                  >
                    {row.name}
                  </th>
                  <td className={CELL}>{row.host}</td>
                  <td className={CELL}>{row.tier}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge
                      label={row.isActive ? "active" : "paused"}
                      tone={siteActiveTone(row.isActive)}
                    />
                  </td>
                  <td
                    className={`${CELL} text-right tabular-nums`}
                    data-numeric
                  >
                    {row.dailyRequestCap}
                  </td>
                  <td
                    className={`${CELL} text-right tabular-nums`}
                    data-numeric
                  >
                    {row.minRequestInterval}
                  </td>
                  <td className="py-3 pr-4">
                    <EnforcementBadge enforcement={row.enforcement} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
