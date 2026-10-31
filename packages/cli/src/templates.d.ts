// CI check templates are bundled as text (esbuild loader, scripts/build.mjs).
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.sh" {
  const text: string;
  export default text;
}
declare module "*.yml" {
  const text: string;
  export default text;
}
