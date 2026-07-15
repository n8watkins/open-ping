import type { Env as WorkerEnv } from "../../src/worker/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }

    interface GlobalProps {
      mainModule: typeof import("../../src/worker/index");
    }
  }
}

export {};
