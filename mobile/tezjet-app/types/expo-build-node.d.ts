/** Local minimal Node imports used by the Expo config at build time.
 * Expo CLI provides Node at runtime; the mobile app has no Node type package.
 */
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:path" {
  export function resolve(...paths: string[]): string;
}
