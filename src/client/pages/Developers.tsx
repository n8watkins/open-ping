import { useState } from "react";
import { Outlet, useOutletContext } from "react-router-dom";
import { Bot, KeyRound, LayoutTemplate, SquareTerminal, Webhook } from "lucide-react";
import { SectionLayout, type SectionNavItem } from "../components/SectionLayout";
import { useBootstrap } from "../lib/bootstrap";

/**
 * Developers: everything for reaching OpenPing from code. API tokens, the MCP
 * server, the CLI, webhook payloads, and embeds and feeds.
 */
const ITEMS: SectionNavItem[] = [
  { to: "/developers/tokens", label: "API tokens", hint: "For the API, MCP and CLI", icon: KeyRound },
  { to: "/developers/mcp", label: "MCP server", hint: "For AI clients", icon: Bot },
  { to: "/developers/cli", label: "CLI", hint: "op.mjs commands", icon: SquareTerminal },
  { to: "/developers/webhooks", label: "Webhooks", hint: "Payload and signatures", icon: Webhook },
  { to: "/developers/embeds", label: "Embeds & feeds", hint: "Badge, widget, RSS", icon: LayoutTemplate },
];

export interface DevelopersContext {
  /**
   * The token created in this visit, kept only in memory so the MCP and CLI
   * snippets can include it. Gone on reload, like the one-time reveal.
   */
  fresh: { token: string; id: string } | null;
  setFresh: (fresh: { token: string; id: string } | null) => void;
  /** The install's public address, for snippets. */
  origin: string;
}

export function useDevelopers(): DevelopersContext {
  return useOutletContext<DevelopersContext>();
}

export default function Developers() {
  const { status } = useBootstrap();
  const [fresh, setFresh] = useState<DevelopersContext["fresh"]>(null);
  const origin = (status?.passkeyOrigin ?? window.location.origin).replace(/\/+$/, "");
  return (
    <SectionLayout
      title="Developers"
      description="Reach OpenPing from code: the API, AI clients over MCP, the CLI, webhooks and embeds."
      label="Developers sections"
      items={ITEMS}
    >
      <Outlet context={{ fresh, setFresh, origin } satisfies DevelopersContext} />
    </SectionLayout>
  );
}
