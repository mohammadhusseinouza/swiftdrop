import { Navigate } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import {
  selectAuthStatus,
  selectCurrentUser,
} from '../../features/auth/authSlice';
import { decideRoot } from './decisions';

/**
 * Auth-aware `/` handler. Renders only inside AuthBootstrapBoundary, so
 * `status` is already resolved to 'authenticated' | 'unauthenticated'.
 */
export default function RootRedirect() {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const decision = decideRoot(status, user);

  switch (decision.kind) {
    case 'redirect':
      return <Navigate to={decision.to} replace />;
    case 'unauthorized':
      return <Navigate to="/unauthorized" replace />;
    default:
      return <Navigate to="/auth/login" replace />;
  }
}
