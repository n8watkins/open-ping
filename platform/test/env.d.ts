import type { PlatformEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // The test Worker's env: the platform's bindings that run locally (no
    // dispatch namespace or queue in workerd; tests inject the fake), plus
    // the migrations to apply.
    interface Env extends Pick<PlatformEnv, "HOSTED_DOMAIN" | "PLATFORM_DB"> {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
