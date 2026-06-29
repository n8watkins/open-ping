import { Routes, Route } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { Placeholder } from "./components/Placeholder";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

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
  );
}
