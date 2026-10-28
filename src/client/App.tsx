import { Routes, Route, Outlet } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { BootstrapProvider, useBootstrap } from "./lib/bootstrap";
import { rootView } from "./lib/home";
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
const Install = lazy(() => import("./pages/Install"));
// The embeddable status widget (/embed) is a standalone public surface meant to
// be iframed cross-origin; lazy-load so it ships its own tiny bundle.
const Embed = lazy(() => import("./pages/Embed"));
// Free public utility tools (/tools). Each is a standalone, client-only page;
// lazy-loaded so they don't weigh on the app or other public entry points.
const ToolsIndex = lazy(() => import("./pages/tools/ToolsIndex"));
const UptimeCalculator = lazy(() => import("./pages/tools/UptimeCalculator"));
const SubnetCalculator = lazy(() => import("./pages/tools/SubnetCalculator"));
const CronTester = lazy(() => import("./pages/tools/CronTester"));
const DnsLookup = lazy(() => import("./pages/tools/DnsLookup"));
const MxLookup = lazy(() => import("./pages/tools/MxLookup"));
const IsItDown = lazy(() => import("./pages/tools/IsItDown"));
const Monitors = lazy(() => import("./pages/Monitors"));
const MonitorDetail = lazy(() => import("./pages/MonitorDetail"));
const MonitorEditor = lazy(() => import("./pages/MonitorEditor"));
const Incidents = lazy(() => import("./pages/Incidents"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Settings = lazy(() => import("./pages/Settings"));
const Maintenance = lazy(() => import("./pages/Maintenance"));
const StatusPageSettings = lazy(() => import("./pages/StatusPageSettings"));
const StatusPageEditor = lazy(() => import("./pages/StatusPageEditor"));

function PageFallback() {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <Loader2 className="size-6 animate-spin text-ink-faint" />
    </div>
  );
}

/**
 * Gate for the site root "/" (the decision itself is lib/home.ts rootView):
 *  - while the bootstrap loads: the shared spinner, so no one sees one page
 *    flash before another;
 *  - a signed-in admin: <Outlet/>, so the nested AppLayout and Dashboard
 *    render exactly as on any other admin route;
 *  - anyone else: the HOME_PAGE choice. OpenPing's marketing page only on a
 *    "landing" install (the canonical one); everywhere else this install's
 *    own default status page, because each install belongs to its owner.
 *
 * AppLayout's own auth redirect never fires for guests, since the nested
 * layout only mounts for a signed-in admin.
 */
function RootIndex() {
  const view = rootView(useBootstrap());
  if (view === "loading") return <PageFallback />;
  if (view === "dashboard") return <Outlet />;
  if (view === "landing") return <Landing />;
  return <PublicStatus asHome />;
}

export default function App() {
  return (
    <BootstrapProvider>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/install" element={<Install />} />
          <Route path="/status" element={<PublicStatus />} />
          <Route path="/status/:slug" element={<PublicStatus />} />
          <Route path="/embed" element={<Embed />} />

          {/* Free public utility tools. */}
          <Route path="/tools" element={<ToolsIndex />} />
          <Route path="/tools/uptime-calculator" element={<UptimeCalculator />} />
          <Route path="/tools/subnet-calculator" element={<SubnetCalculator />} />
          <Route path="/tools/cron-tester" element={<CronTester />} />
          <Route path="/tools/dns-lookup" element={<DnsLookup />} />
          <Route path="/tools/mx-lookup" element={<MxLookup />} />
          <Route path="/tools/is-it-down" element={<IsItDown />} />

          {/* Site root: the dashboard for admins; the HOME_PAGE choice for guests. */}
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
            <Route path="/status-page/new" element={<StatusPageEditor />} />
            <Route path="/status-page/:id" element={<StatusPageEditor />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BootstrapProvider>
  );
}
