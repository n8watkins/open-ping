import { Link } from "react-router-dom";
import { EdgePage, primaryAction, secondaryAction } from "../components/EdgePage";

// Rendered for any path the app has no page for; the Worker sends it with a
// real 404 status (src/shared/client-routes.ts).
export default function NotFound() {
  return (
    <EdgePage
      label="404 - page not found"
      title="Nothing is being monitored here."
      actions={
        <>
          <Link to="/" className={primaryAction}>
            Go to the home page
          </Link>
          <Link to="/status" className={secondaryAction}>
            See the status page
          </Link>
        </>
      }
    >
      This address isn&apos;t a page in OpenPing. Your monitors and status pages are unaffected.
    </EdgePage>
  );
}
