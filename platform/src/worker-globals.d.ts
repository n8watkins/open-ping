// Types ctx.exports from this Worker's own exports (workers-types reads
// Cloudflare.GlobalProps.mainModule), so ctx.exports.TenantPlatform is typed.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

export {};
