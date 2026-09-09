import type { ReactNode } from "react";

/**
 * The form language of the Stitch design, transcribed from the Project Settings
 * screen.
 *
 * NONE OF THIS EXISTED. Every screen through D3b was tables, badges and
 * definition grids — there was no input, select, checkbox or button anywhere in
 * the app, which is a large part of why the first Settings attempt came out as a
 * table of environment variables rather than a form.
 *
 * Built from existing tokens only. An input is filled with `bg-base` inside a
 * `bg-surface-raised` panel, which is how the design gets a recessed control
 * without a new colour: `docs/DESIGN.md` bans adding a token that the design
 * does not define, and the reset in `globals.css` means an invented one would
 * not compile anyway.
 *
 * PROVENANCE: these are matched to a screenshot, not to the design's generated
 * `tailwind.config` the way ADR-0027's palette was. Spacing and radii are
 * inferred. See ADR-0031.
 */

const LABEL =
  "block font-mono text-2xs font-medium uppercase tracking-wider text-tertiary";

const CONTROL =
  "w-full rounded-sm border border-border-subtle bg-base px-3 py-2 text-sm text-primary transition-colors placeholder:text-tertiary hover:border-border-strong focus:border-accent-text disabled:cursor-not-allowed disabled:text-tertiary";

/** A labelled control, with room for a hint the reader needs. */
export function Field({
  label,
  htmlFor,
  hint,
  children
}: {
  readonly label: string;
  readonly htmlFor: string;
  /** Shown under the control — use it for what an empty value means. */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <label className={LABEL} htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-2">{children}</div>
      {hint !== undefined && (
        <p className="mt-2 text-2xs leading-relaxed text-tertiary">{hint}</p>
      )}
    </div>
  );
}

/**
 * A multi-line control, for input the reader pastes rather than types.
 *
 * Monospace, because every use of it so far is a list of URLs: proportional
 * type makes a column of paths hard to scan for the one that is different, and
 * the same reasoning already puts URLs in JetBrains Mono everywhere else.
 * `spellCheck` off for the same reason — a red underline under every path is
 * noise.
 */
export function TextArea({
  id,
  name,
  defaultValue,
  placeholder,
  rows = 10,
  maxLength,
  disabled
}: {
  readonly id: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly maxLength?: number;
  readonly disabled?: boolean;
}) {
  return (
    <textarea
      className={`${CONTROL} resize-y font-mono text-xs`}
      defaultValue={defaultValue}
      disabled={disabled}
      id={id}
      maxLength={maxLength}
      name={name}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
    />
  );
}

/** Two fields side by side, as the design pairs frequency and depth. */
export function FieldRow({ children }: { readonly children: ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>;
}

/** Vertical rhythm between fields, and the divider before a checkbox group. */
export function FieldStack({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

export function FieldDivider() {
  return <hr className="my-6 border-0 border-t border-border-subtle" />;
}

export function TextInput({
  id,
  name,
  defaultValue,
  placeholder,
  inputMode,
  disabled
}: {
  readonly id: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly inputMode?: "numeric" | "url" | "text";
  readonly disabled?: boolean;
}) {
  return (
    <input
      className={CONTROL}
      defaultValue={defaultValue}
      disabled={disabled}
      id={id}
      inputMode={inputMode}
      name={name}
      placeholder={placeholder}
      type="text"
    />
  );
}

export function Select({
  id,
  name,
  defaultValue,
  options,
  disabled
}: {
  readonly id: string;
  readonly name: string;
  readonly defaultValue?: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
  readonly disabled?: boolean;
}) {
  return (
    <select
      className={`${CONTROL} appearance-none bg-[right_0.75rem_center] bg-no-repeat pr-9`}
      defaultValue={defaultValue}
      disabled={disabled}
      id={id}
      name={name}
      style={{
        // The design's chevron. Inlined as a data URI rather than an <svg>
        // sibling so the native select keeps its own keyboard behaviour.
        backgroundImage:
          "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%23918fa1' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")"
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A checkbox row: control, then its label as clickable text.
 *
 * The design shows an indigo fill when checked. `accent-color` gets that from
 * the native control, which keeps focus, keyboard and screen-reader behaviour
 * rather than reimplementing them under a styled span.
 */
export function CheckboxRow({
  id,
  name,
  label,
  defaultChecked,
  disabled
}: {
  readonly id: string;
  readonly name: string;
  readonly label: ReactNode;
  readonly defaultChecked?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        className="h-4 w-4 rounded-xs border border-border-subtle bg-base disabled:cursor-not-allowed"
        defaultChecked={defaultChecked}
        disabled={disabled}
        id={id}
        name={name}
        style={{ accentColor: "var(--accent)" }}
        type="checkbox"
      />
      <label className="text-sm text-secondary" htmlFor={id}>
        {label}
      </label>
    </div>
  );
}

/**
 * The design's two button weights: an accent fill and a quiet text action.
 *
 * `--accent` is a FILL and `--accent-foreground` is what sits on it — the
 * primary button is the case the two-token split in `docs/DESIGN.md` §3 exists
 * for, and reaching for `text-accent` here would be the mistake it warns about.
 */
export function Button({
  children,
  type = "button",
  variant = "ghost",
  disabled,
  onClick
}: {
  readonly children: ReactNode;
  readonly type?: "button" | "submit" | "reset";
  readonly variant?: "primary" | "ghost";
  readonly disabled?: boolean;
  /** Only meaningful from a Client Component; omit for a plain submit. */
  readonly onClick?: () => void;
}) {
  const base =
    "rounded-sm px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <button
      className={
        variant === "primary"
          ? `${base} bg-accent text-accent-foreground hover:bg-accent/90`
          : `${base} text-secondary hover:bg-surface hover:text-primary`
      }
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}
