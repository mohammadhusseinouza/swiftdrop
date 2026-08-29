/**
 * Phase 10.5 temporary auth-bootstrap views. Minimal Tailwind only — the
 * reusable LoadingState / ErrorState design-system components are Phase 10.6.
 */

export function BootstrapLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6 dark:bg-slate-950">
      <p
        className="text-sm text-slate-500 dark:text-slate-400"
        role="status"
        aria-live="polite"
      >
        Checking your session…
      </p>
    </main>
  );
}

export function BootstrapError({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        Unable to verify your session
      </h1>
      <p className="max-w-sm text-sm text-slate-600 dark:text-slate-400">
        We couldn&apos;t reach the server to check whether you&apos;re signed in.
        This is usually temporary.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white"
      >
        Retry
      </button>
    </main>
  );
}
