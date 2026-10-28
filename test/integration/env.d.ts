import type { Env as WorkerEnv } from "../../src/worker/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** A second database no test setup migrates (hosted-platform.test.ts). */
      FRESH_DB: D1Database;
    }

    interface GlobalProps {
      mainModule: typeof import("../../src/worker/index");
    }
  }
}

export {};
