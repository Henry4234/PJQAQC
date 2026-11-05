import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../frontend/", import.meta.url);
const output = new URL("../.deploy-tools/cloudflare-preview/", import.meta.url);
const directory = new URL("./", import.meta.url);

function replaceOnce(text, marker, replacement) {
  if (text.split(marker).length !== 2) {
    throw new Error(`The frontend has changed at the preview insertion point: ${marker}`);
  }
  return text.replace(marker, replacement);
}

let html = await readFile(new URL("index.html", source), "utf8");
html = replaceOnce(html, "<title>QAQC 品管管理系統</title>",
  '<title>PJQAQC｜Cloudflare 前端預覽</title>\n  <link rel="stylesheet" href="preview.css">');
html = replaceOnce(html, "<main>",
  '<main>\n      <p class="preview-notice">Cloudflare 前端預覽 · 使用合成資料，可瀏覽儀表板、品管紀錄與 L-J 趨勢。</p>');
html = replaceOnce(html, '<script src="app.js"></script>',
  '<script src="preview.js"></script>\n  <script src="app.js"></script>');

const app = replaceOnce(await readFile(new URL("app.js", source), "utf8"),
  "const res = await fetch(API + path, opts);",
  "const res = await window.pjqaqcPreviewFetch(API + path, opts);");

await mkdir(output, { recursive: true });
const assetNames = new Set(["index.html", "app.js", "style.css", "preview.js", "preview.css", "_headers"]);
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!entry.isFile() || !assetNames.has(entry.name)) {
    throw new Error(`Unexpected entry in the preview publish directory: ${entry.name}`);
  }
}
await Promise.all([
  writeFile(new URL("index.html", output), html, "utf8"),
  writeFile(new URL("app.js", output), app, "utf8"),
  copyFile(new URL("style.css", source), new URL("style.css", output)),
  ...["preview.js", "preview.css", "_headers"].map(
    (name) => copyFile(new URL(name, directory), new URL(name, output)),
  ),
]);
console.log("Cloudflare preview assets built from frontend/.");
