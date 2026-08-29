import { RouterProvider } from 'react-router-dom';
import { router } from './routes/router';

/**
 * Router entry boundary. The route tree lives in src/routes/routeTree.tsx and
 * is wrapped by AuthBootstrapBoundary + portal/permission guards (Phase 10.5).
 *
 * Route group ownership: /auth → Phase 11.1, /management → Phase 11,
 * /driver → Phase 12, /customer → Phase 13, /track → Phase 14.
 *
 * The backend remains the authoritative security boundary; frontend guards are
 * UX only.
 */
export default function App() {
  return <RouterProvider router={router} />;
}
