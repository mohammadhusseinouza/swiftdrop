import { humanizeToken } from '../../../lib/format';

/**
 * Read-only viewer for an audit `previousValues` / `newValues` / `metadata`
 * blob. Renders strings / numbers / booleans / null / arrays / shallow-nested
 * objects as plain text only — audit values are NEVER HTML. Bounded depth so
 * a pathological payload can't blow the stack.
 *
 * DEFENSE IN DEPTH: the backend audit DTO is the authority for redaction, but
 * this viewer also refuses to print a value under a sensitive-looking key. If
 * one ever appears, that is a backend bug to fix at the source.
 */

const MAX_DEPTH = 4;

const SENSITIVE_KEY = /(pass(word)?|pwd|hash|secret|token|jwt|cookie|authorization|idempotenc|refresh)/i;

function primitiveText(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return String(v);
}

function ValueNode({ value, depth }: { value: unknown; depth: number }) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return (
      <span className="break-words tabular-nums text-ink">
        {primitiveText(value)}
      </span>
    );
  }

  if (depth >= MAX_DEPTH) {
    return <span className="text-ink-subtle">(nested value hidden)</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-subtle">(empty list)</span>;
    return (
      <ul className="ml-3 list-disc space-y-0.5">
        {value.map((item, i) => (
          <li key={i}>
            <ValueNode value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-ink-subtle">(empty)</span>;
    return (
      <dl className="ml-3 space-y-1">
        {entries.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-x-2 text-sm">
            <dt className="font-medium text-ink-secondary">{humanizeToken(k)}</dt>
            <dd className="min-w-0">
              {SENSITIVE_KEY.test(k) ? (
                <span className="text-danger-700">[redacted]</span>
              ) : (
                <ValueNode value={v} depth={depth + 1} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span className="text-ink-subtle">(unsupported value)</span>;
}

export function AuditValueBlock({
  title,
  value,
}: {
  title: string;
  value: unknown | null;
}) {
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0);

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>
      <div className="mt-1 rounded-control border border-line-subtle bg-sunken/40 p-3 text-sm">
        {empty ? (
          <span className="text-ink-muted">
            No field snapshot was recorded for this event.
          </span>
        ) : (
          <ValueNode value={value} depth={0} />
        )}
      </div>
    </div>
  );
}

/**
 * A key-by-key change view when BOTH previous and new snapshots exist —
 * `old → new` per changed key. Falls back to two blocks otherwise.
 */
export function AuditChangeView({
  previousValues,
  newValues,
}: {
  previousValues: unknown | null;
  newValues: unknown | null;
}) {
  const prev = asRecord(previousValues);
  const next = asRecord(newValues);

  if (!prev || !next) {
    return (
      <div className="space-y-3">
        <AuditValueBlock title="Previous values" value={previousValues} />
        <AuditValueBlock title="New values" value={newValues} />
      </div>
    );
  }

  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        Changes
      </h3>
      <dl className="mt-1 divide-y divide-line-subtle rounded-control border border-line-subtle">
        {keys.map((k) => {
          const redacted = SENSITIVE_KEY.test(k);
          return (
            <div key={k} className="px-3 py-2 text-sm">
              <dt className="font-medium text-ink-secondary">{humanizeToken(k)}</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                {redacted ? (
                  <span className="text-danger-700">[redacted] → [redacted]</span>
                ) : (
                  <>
                    <span className="rounded bg-danger-50 px-1.5 py-0.5 text-danger-700 line-through">
                      {inlineValue(prev[k])}
                    </span>
                    <span aria-hidden="true" className="text-ink-muted">
                      →
                    </span>
                    <span className="rounded bg-success-50 px-1.5 py-0.5 text-success-700">
                      {inlineValue(next[k])}
                    </span>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function inlineValue(v: unknown): string {
  if (v === undefined) return '(not set)';
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  return String(v);
}
