// Markdown files are bundled as plain text: the Text module rule in
// wrangler.jsonc, and the matching plugin in vitest.config.ts.
declare module "*.md" {
  const text: string;
  export default text;
}
