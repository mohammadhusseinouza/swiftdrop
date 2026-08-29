import { Outlet } from 'react-router-dom';

/**
 * Phase 10.2 ROUTING BOUNDARY ONLY.
 *
 * The real Customer Portal shell is Phase 13. Auth/permission guards for this
 * group are Phase 10.5.
 */
export default function CustomerLayout() {
  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
