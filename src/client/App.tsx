import { Routes, Route, Outlet } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { BootstrapProvider, useBootstrap } from "./lib/bootstrap";
import { AppLayout } from "./components/AppLayout";
import PublicStatus from "./pages/PublicStatus";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import NotFound from "./pages/NotFound";

// Admin pages are code-split (lazy) so the public status page (/status) and the
// login/setup entry points don't ship the large authenticated dashboard bundle.
const Dashboard = lazy(() => import("./pages/Dashboard"));
// The marketing landing page is public; lazy-load it so it doesn't weigh down
// the other public entry points (/login, /status).
const Landing = lazy(() => import("./pages/Landing"));
// The embeddable status widget (/embed) is a standalone public surface meant to
// be iframed cross-origin; lazy-load so it ships its own tiny bundle.
const Embed = lazy(() => import("./pages/Embed"));
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

/**
 * Gate for the site root "/".
 *  - while auth is loading: show the shared spinner (avoids a Landing flash);
 *  - authenticated admin: render <Outlet/> so the nested AppLayout→Dashboard
 *    renders exactly as before (chrome, nav, status pill, etc.);
 *  - unauthenticated visitor: render the marketing Landing page.
 *
 * This keeps the Dashboard at "/" (so AppLayout's "Overview" nav link is
 * untouched) while never letting AppLayout's own auth redirect fire for guests,
 * since the nested layout only mounts when the visitor is authenticated.
 */
function RootIndex() {
  const { loading, me } = useBootstrap();
  if (loading) return <PageFallback />;
  if (me?.authenticated) return <Outlet />;
  return <Landing />;
}

export default function App() {
  return (
    <BootstrapProvider>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/status" element={<PublicStatus />} />
          <Route path="/embed" element={<Embed />} />

          {/* Site root: Landing for guests, Dashboard (in AppLayout) for admins. */}
          <Route path="/" element={<RootIndex />}>
            <Route element={<AppLayout />}>
              <Route index element={<Dashboard />} />
            </Route>
          </Route>

          <Route element={<AppLayout />}>
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
