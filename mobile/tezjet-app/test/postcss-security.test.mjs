import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const appRequire = createRequire(new URL("../package.json", import.meta.url));
const expoRequire = createRequire(appRequire.resolve("expo/package.json"));
const metroPackage = expoRequire.resolve("@expo/metro-config/package.json");
const metroRequire = createRequire(metroPackage);
const postcssEntry = metroRequire.resolve("postcss");

async function scenario(name, fixture) {
  // Install this observer before loading PostCSS's destructured fs imports.
  // Only our generated sentinel is observed; no private or host file is read.
  const readFileSync = fs.readFileSync;
  let sentinelReads = 0;
  fs.readFileSync = function (file, ...options) {
    if (String(file) === fixture.sentinel) sentinelReads++;
    return readFileSync.call(this, file, ...options);
  };
  const postcss = appRequire(postcssEntry);
  const input = annotation => `body { color: red }\n/*# sourceMappingURL=${annotation} */`;
  const options = { from: fixture.css, to: fixture.output };
  if (name === "non-map") {
    await postcss([]).process(input("../outside.json"), options);
    assert.equal(sentinelReads, 0, "GHSA-6g55: arbitrary files must not be loaded");
  } else if (name === "traversal") {
    const result = await postcss([]).process(input("../outside.map"), options);
    assert.equal(sentinelReads, 0, "GHSA-r28c: maps outside the CSS directory must not be loaded");
    assert.ok(!JSON.stringify(result.map?.toJSON() ?? null).includes("ONAY_SENTINEL"));
  } else if (name === "no-from") {
    const result = await postcss([]).process(input(fixture.sentinel));
    assert.equal(sentinelReads, 0, "GHSA-fxqj: absent from must not authorize map autoload");
    assert.ok(!JSON.stringify(result.map?.toJSON() ?? null).includes("ONAY_SENTINEL"));
  } else if (name === "style") {
    const result = postcss.parse('body { content: "</StYlE><script>example</script><style>"; }').toResult();
    assert.doesNotMatch(result.css, /<\/style/i, "GHSA-qx2v: serialized CSS must not close an HTML style tag");
    assert.match(result.css, /\\3c /i, "the less-than character must be escaped without executing HTML");
  } else if (name === "local-map") {
    const result = await postcss([]).process(input("local.css.map"), { ...options, map: { inline: false } });
    assert.ok(result.map.toJSON().sourcesContent.includes("SAFE_LOCAL_SOURCE"));
  } else if (name === "inline-map") {
    const map = Buffer.from(JSON.stringify(fixture.localMap)).toString("base64");
    const result = await postcss([]).process(input("data:application/json;base64," + map), { ...options, map: { inline: false } });
    assert.ok(result.map.toJSON().sourcesContent.includes("SAFE_LOCAL_SOURCE"));
  } else if (name === "metro") {
    const transformer = metroRequire("./build/transform-worker/postcss.js");
    const result = await transformer.transformPostCssModule(fixture.directory, {
      src: "body { color: red }", filename: fixture.css,
    });
    assert.equal(result.hasPostcss, true, "exercise actual config-discovered Metro branch");
    assert.match(result.src, /color: green/, "Metro must execute the configured PostCSS plugin");
    assert.match(result.src, /sourceMappingURL=data:application\/json/, "Metro map:true must still generate an inline map");
  } else {
    throw new Error("Unknown bounded test scenario");
  }
  return true;
}

if (!isMainThread) {
  scenario(workerData.name, workerData.fixture).then(
    () => parentPort.postMessage({ ok: true }),
    error => parentPort.postMessage({ ok: false, message: String(error.stack || error) }),
  );
} else {
  const cases = [
    ["non-map", "PostCSS rejects external non-map annotations (GHSA-6g55-p6wh-862q)"],
    ["traversal", "PostCSS rejects traversing source maps (GHSA-r28c-9q8g-f849)"],
    ["no-from", "PostCSS does not autoload a map without from (GHSA-fxqj-rqcc-2cmp)"],
    ["style", "PostCSS escapes closing-style serialization (GHSA-qx2v-qp2m-jg93)"],
    ["local-map", "PostCSS retains legitimate local source maps"],
    ["inline-map", "PostCSS retains legitimate inline source maps"],
    ["metro", "actual Metro CSS transformer retains plugin and map compatibility"],
  ];
  for (const [name, description] of cases) {
    test(description, { timeout: 15_000 }, async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "onay-postcss-"));
      let worker;
      try {
        const directory = path.join(temporary, "css");
        await mkdir(directory);
        const css = path.join(directory, "input.css");
        const sentinel = path.join(temporary, name === "non-map" ? "outside.json" : "outside.map");
        const localMap = { version: 3, file: "input.css", sources: ["original.css"], sourcesContent: ["SAFE_LOCAL_SOURCE"], names: [], mappings: "AAAA" };
        await writeFile(css, "body { color: red }");
        await writeFile(sentinel, JSON.stringify({ ...localMap, sourcesContent: ["ONAY_SENTINEL"] }));
        await writeFile(path.join(directory, "local.css.map"), JSON.stringify(localMap));
        await writeFile(path.join(directory, "postcss.config.mjs"), `export default { map: true, plugins: [{ postcssPlugin: "onay-test", Declaration(declaration) { if (declaration.prop === "color") declaration.value = "green"; } }] };\n`);
        const fixture = { directory, css, sentinel, localMap, output: path.join(directory, "output.css") };
        await new Promise((resolve, reject) => {
          worker = new Worker(new URL(import.meta.url), { workerData: { name, fixture }, execArgv: [] });
          const timer = setTimeout(() => reject(new Error("PostCSS worker exceeded 10-second bound")), 10_000);
          worker.once("message", message => {
            clearTimeout(timer);
            message.ok ? resolve() : reject(new Error(message.message));
          });
          worker.once("error", error => { clearTimeout(timer); reject(error); });
          worker.once("exit", code => {
            if (code !== 0) { clearTimeout(timer); reject(new Error("PostCSS worker exited " + code)); }
          });
        });
      } finally {
        if (worker) await worker.terminate();
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
}
