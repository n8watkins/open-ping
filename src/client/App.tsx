import { Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { BootstrapProvider } from "./lib/bootstrap";
import { AppLayout } from "./components/AppLayout";
import PublicStatus from "./pages/PublicStatus";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import NotFound from "./pages/NotFound";

// Admin pages are code-split (lazy) so the public status page (/status) and the
// login/setup entry points don't ship the large authenticated dashboard bundle.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Monitors = lazy(() => import("./pages/Monitors"));
const MonitorDetail = lazy(() => import("./pages/MonitorDetail"));
const MonitorEditor = lazy(() => import("./pages/MonitorEditor"));
const Incidents = lazy(() => import("./pages/Incidents"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Settings = lazy(() => import("./pages/Settings"));
const Maintenance = lazy(() => import("./pages/Maintenance"));
const StatusPageSettings = lazy(() => import("./pages/StatusPageSettings"));

function PageFallback() {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <Loader2 className="size-6 animate-spin text-ink-faint" />
    </div>
  );
}

export default function App() {
  return (
    <BootstrapProvider>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/status" element={<PublicStatus />} />

          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/monitors" element={<Monitors />} />
            <Route path="/monitors/new" element={<MonitorEditor />} />
            <Route path="/monitors/:id" element={<MonitorDetail />} />
            <Route path="/monitors/:id/edit" element={<MonitorEditor />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/maintenance" element={<Maintenance />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/status-page" element={<StatusPageSettings />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BootstrapProvider>
  );
}
