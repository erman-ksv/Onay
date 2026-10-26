import express, { type Express } from "express";
import { statSync } from "node:fs";
import { resolve } from "node:path";

/** Serve only the compiled login shell/assets; all data APIs retain their guards. */
export function mountAdminUi(app: Express, distDirectory: string): void {
  const root = resolve(distDirectory);
  const index = resolve(root, "index.html");
  const assets = resolve(root, "assets");
  if (!statSync(index, { throwIfNoEntry: false })?.isFile() ||
      !statSync(assets, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Admin UI build is missing");
  }
  app.get("/admin", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    response.sendFile(index, { cacheControl: false, dotfiles: "deny" });
  });
  app.use("/assets", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(assets, { index: false, redirect: false, dotfiles: "deny", cacheControl: false }));
}
