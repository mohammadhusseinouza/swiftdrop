import { useParams } from 'react-router-dom';

/**
 * Phase 10.2 development-only placeholder.
 *
 * Exists purely to verify route matching, nested layout rendering and route
 * params. Contains ZERO API calls, forms, tables or business/demo data.
 * Every real page replaces its placeholder in the phase noted below.
 */
interface RoutePlaceholderProps {
  section: string;
  title: string;
  /** Implementation phase that owns the real page, e.g. "Phase 11.3". */
  phase: string;
}

export default function RoutePlaceholder({
  section,
  title,
  phase,
}: RoutePlaceholderProps) {
  const params = useParams();
  const paramEntries = Object.entries(params).filter(
    ([, value]) => value !== undefined,
  );

  return (
    <section className="mx-auto max-w-2xl">
      <p className="text-xs font-semibold tracking-wide text-brand-600 uppercase">
        {section}
      </p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {title}
      </h1>
      <p className="mt-3 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        Route shell ready — page implemented in {phase}.
      </p>

      {paramEntries.length > 0 && (
        <dl className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-950">
          {paramEntries.map(([key, value]) => (
            <div key={key} className="flex gap-2">
              <dt className="font-medium text-slate-500">{key}</dt>
              <dd className="font-mono text-slate-900 dark:text-slate-100">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
