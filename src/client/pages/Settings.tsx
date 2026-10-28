import { FileBarChart, ServerCog, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { SectionLayout, type SectionNavItem } from "../components/SectionLayout";

/**
 * Settings, split into four short sub-pages (pages/settings/*): what you can
 * change sits apart from what you only read.
 */
const ITEMS: SectionNavItem[] = [
  { to: "/settings/general", label: "General", hint: "Timezone, address, email", icon: SlidersHorizontal },
  { to: "/settings/security", label: "Sign-in & security", hint: "Passkeys, sessions, keys", icon: ShieldCheck },
  { to: "/settings/reports", label: "Reports", hint: "Monthly and weekly", icon: FileBarChart },
  { to: "/settings/system", label: "System", hint: "Health, usage, version", icon: ServerCog },
];

export default function Settings() {
  return (
    <SectionLayout
      title="Settings"
      description="How this install runs, who can sign in, and what it reports."
      label="Settings sections"
      items={ITEMS}
    />
  );
}
