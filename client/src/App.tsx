import { RouterProvider } from 'react-router-dom';
import { router } from './routes/router';

/**
 * Router entry boundary. The route tree lives in src/routes/router.tsx.
 *
 * Route group ownership (keep placeholders from being mistaken for features):
 *   /auth       — Login is Phase 11.1
 *   /management — Phase 11
 *   /driver     — Phase 12
 *   /customer   — Phase 13
 *   /track      — Public Tracking is Phase 14
 *
 * No auth/permission guards yet (Phase 10.5). The backend is authoritative.
 */
export default function App() {
  return <RouterProvider router={router} />;
}
