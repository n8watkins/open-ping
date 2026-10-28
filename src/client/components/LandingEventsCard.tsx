import { useFetch } from "../lib/useFetch";
import { useBootstrap } from "../lib/bootstrap";
import { Card, CardHeader, CardTitle } from "./ui/Card";

/** GET /api/events (src/worker/routes/events.ts). */
interface EventsResponse {
  dailyCap: number;
  totals: { name: string; last7: number; last30: number }[];
}

/** What each counted event means, in the order the server lists them. */
const LABELS: Record<string, string> = {
  landing_view: "Landing page views",
  hero_deploy: "Hero: Deploy free",
  hero_waitlist: "Hero: Join the waitlist",
  hero_trial: "Hero: Start a free trial",
  hero_status: "Hero: Live status page",
  hero_tools: "Hero: Free tools",
  nav_deploy: "Header: Deploy free",
  nav_trial: "Header: Start a free trial",
  pricing_view: "Pricing section seen",
  pricing_deploy: "Pricing: Deploy free",
  pricing_trial: "Pricing: Start a free trial",
  waitlist_join: "Waitlist sign-ups sent",
  cta_deploy: "Closing: Deploy free",
  cta_waitlist: "Closing: Join the waitlist",
  cta_trial: "Closing: Start a free trial",
  install_view: "Install guide views",
  install_deploy: "Install guide: Deploy to Cloudflare",
  signin_open: "Owner sign-in opened",
  signin_not_admin: "Sign-ins by someone not the admin",
};

/**
 * Landing page click counts, shown beside the Hosted waitlist in Settings.
 * Only a HOME_PAGE="landing" install counts them; elsewhere there is no
 * endpoint to ask, and this renders nothing.
 */
export function LandingEventsCard() {
  const { status } = useBootstrap();
  const { data } = useFetch<EventsResponse>(status?.homePage === "landing" ? "/api/events" : null);
  if (!data) return null;
  return (
    <section id="landing-counts" className="scroll-mt-6">
      <Card className="p-5">
        <CardHeader>
          <CardTitle>Landing page counts</CardTitle>
        </CardHeader>
        <p className="-mt-1 mb-4 text-sm text-ink-muted">
          Daily totals only: no cookies, and nothing about who clicked. Each event counts once per page view,
          up to {data.dailyCap.toLocaleString()} a day.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-faint">
                <th scope="col" className="py-2 pr-3 font-medium">Event</th>
                <th scope="col" className="whitespace-nowrap py-2 px-3 text-right font-medium">7 days</th>
                <th scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-medium">30 days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.totals.map((t) => (
                <tr key={t.name}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal text-ink">
                    {LABELS[t.name] ?? t.name}
                  </th>
                  <td className="py-2 px-3 text-right tabular-nums text-ink-muted">{t.last7.toLocaleString()}</td>
                  <td className="py-2 pl-3 text-right tabular-nums text-ink">{t.last30.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
