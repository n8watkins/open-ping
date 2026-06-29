import { Routes, Route } from "react-router-dom";
import { BootstrapProvider } from "./lib/bootstrap";
import { AppLayout } from "./components/AppLayout";
import { Placeholder } from "./components/Placeholder";
import Dashboard from "./pages/Dashboard";
import Monitors from "./pages/Monitors";
import MonitorDetail from "./pages/MonitorDetail";
import MonitorEditor from "./pages/MonitorEditor";
import Incidents from "./pages/Incidents";
import Integrations from "./pages/Integrations";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import Setup from "./pages/Setup";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <BootstrapProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/setup" element={<Setup />} />

        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/monitors" element={<Monitors />} />
          <Route path="/monitors/new" element={<MonitorEditor />} />
          <Route path="/monitors/:id" element={<MonitorDetail />} />
          <Route path="/monitors/:id/edit" element={<MonitorEditor />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/maintenance" element={<Placeholder title="Maintenance" />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </BootstrapProvider>
  );
}
