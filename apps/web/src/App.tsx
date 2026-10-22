import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { AdminPage } from './pages/AdminPage';
import { CapacityPage } from './pages/CapacityPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NetworkPage } from './pages/NetworkPage';
import { NewShiftPage } from './pages/NewShiftPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ImportWorkersPage } from './pages/ImportWorkersPage';
import { AcceptInvitePage } from './pages/AcceptInvitePage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { NotificationSettingsPage } from './pages/NotificationSettingsPage';
import { TrustPage } from './pages/TrustPage';
import { CompliancePage } from './pages/CompliancePage';
import { FinancePage } from './pages/FinancePage';
import { AgencyFinancePage } from './pages/AgencyFinancePage';
import { PostedShiftsPage } from './pages/PostedShiftsPage';
import { RegisterPage } from './pages/RegisterPage';
import { SettingsPage } from './pages/SettingsPage';
import { ShiftBoardPage } from './pages/ShiftBoardPage';
import { ShiftDetailPage } from './pages/ShiftDetailPage';
import { StatementsPage } from './pages/StatementsPage';
import { SuppliedShiftsPage } from './pages/SuppliedShiftsPage';
import { TimesheetsPage } from './pages/TimesheetsPage';
import { WorkerDetailPage } from './pages/WorkerDetailPage';
import { WorkersPage } from './pages/WorkersPage';

function RequireAuth({ children, manager, admin, platform }: { children: JSX.Element; manager?: boolean; admin?: boolean; platform?: boolean }) {
  const { me, loading, isManager, isAdmin, isPlatformAdmin } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8"><Loading /></div>;
  if (!me) return <Navigate to="/login" state={{ from: location }} replace />;
  if (platform && !isPlatformAdmin) return <Navigate to="/" replace />;
  if (admin && !isAdmin) return <Navigate to="/" replace />;
  if (manager && !isManager) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="/shifts" element={<ShiftBoardPage />} />
        <Route path="/shifts/new" element={<RequireAuth manager><NewShiftPage /></RequireAuth>} />
        <Route path="/shifts/posted" element={<RequireAuth manager><PostedShiftsPage /></RequireAuth>} />
        <Route path="/shifts/supplied" element={<SuppliedShiftsPage />} />
        <Route path="/shifts/:id" element={<ShiftDetailPage />} />
        <Route path="/capacity" element={<RequireAuth manager><CapacityPage /></RequireAuth>} />
        <Route path="/workers" element={<RequireAuth manager><WorkersPage /></RequireAuth>} />
        <Route path="/workers/import" element={<RequireAuth manager><ImportWorkersPage /></RequireAuth>} />
        <Route path="/workers/:id" element={<WorkerDetailPage />} />
        <Route path="/compliance" element={<RequireAuth manager><CompliancePage /></RequireAuth>} />
        <Route path="/trust" element={<RequireAuth manager><TrustPage /></RequireAuth>} />
        <Route path="/finance" element={<RequireAuth admin><FinancePage /></RequireAuth>} />
        <Route path="/admin/finance" element={<RequireAuth platform><AgencyFinancePage /></RequireAuth>} />
        <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route path="/timesheets" element={<TimesheetsPage />} />
        <Route path="/statements" element={<RequireAuth admin><StatementsPage /></RequireAuth>} />
        <Route path="/network" element={<RequireAuth manager><NetworkPage /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth manager><SettingsPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth platform><AdminPage /></RequireAuth>} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
