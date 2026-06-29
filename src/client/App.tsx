import { Routes, Route } from "react-router-dom";
import { BootstrapProvider } from "./lib/bootstrap";
import { AppLayout } from "./components/AppLayout";
import { Placeholder } from "./components/Placeholder";
import Dashboard from "./pages/Dashboard";
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
          <Route path="/monitors" element={<Placeholder title="Monitors" />} />
          <Route path="/incidents" element={<Placeholder title="Incidents" />} />
          <Route path="/maintenance" element={<Placeholder title="Maintenance" />} />
          <Route path="/integrations" element={<Placeholder title="Integrations" />} />
          <Route path="/settings" element={<Placeholder title="Settings" />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </BootstrapProvider>
  );
}
