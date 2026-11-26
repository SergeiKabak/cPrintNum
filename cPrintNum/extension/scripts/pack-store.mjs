#!/usr/bin/env node
/**
 * Упаковка расширения для магазинов (Microsoft Edge Add-ons, Chrome Web Store).
 *
 * Магазины требуют, чтобы `manifest.json` лежал В КОРНЕ архива (без папки
 * верхнего уровня). `build.sh` делает другой архив — «всё в одной папке»
 * вместе с exe, он для установки вручную, а не для публикации.
 *
 * Результат: dist/store/printnum-<version>.zip + store-logo-300.png (300×300).
 *
 *   node scripts/pack-store.mjs            # собрать архив
 *   node scripts/pack-store.mjs --no-build # без wxt build (взять готовую сборку)
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(HERE, "..");
const ROOT = resolve(EXT_DIR, "..");
const BUILD_DIR = join(EXT_DIR, "output", "chrome-mv3");
const STORE_DIR = join(ROOT, "dist", "store");

const run = (cmd, args, cwd) => {
  process.stdout.write(`$ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
};

if (!process.argv.includes("--no-build")) {
  run("npm", ["run", "build"], EXT_DIR);
}

const manifestPath = join(BUILD_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`❌ Нет сборки: ${manifestPath}\n   Сначала: npm run build`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const version = manifest.version;

// Магазины не любят мусор в архиве.
for (const junk of [".DS_Store", "Thumbs.db"]) {
  const p = join(BUILD_DIR, junk);
  if (existsSync(p)) rmSync(p);
}

mkdirSync(STORE_DIR, { recursive: true });
const zipPath = join(STORE_DIR, `printnum-${version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);

// zip -r из папки сборки: файлы попадают в корень архива.
run("zip", ["-X", "-r", "-9", zipPath, "."], BUILD_DIR);

// Store logo: Edge просит 300×300. Берём بهترین исходник из иконок.
const logoSrc = ["icon/128.png", "icon/96.png", "icon/48.png"]
  .map((p) => join(BUILD_DIR, p))
  .find(existsSync);
const logoOut = join(STORE_DIR, "store-logo-300.png");
if (logoSrc) {
  try {
    // sips есть на macOS; на Linux/Windows просто копируем исходник.
    execFileSync("sips", ["-z", "300", "300", logoSrc, "--out", logoOut], {
      stdio: "ignore",
    });
  } catch {
    copyFileSync(logoSrc, logoOut);
  }
}

const kb = Math.round(statSync(zipPath).size / 1024);
console.log("");
console.log(`✅ ${zipPath}  (${kb} КБ, версия ${version})`);
console.log(`   manifest.json — в корне архива`);
if (manifest.name) console.log(`   name: ${manifest.name}`);
if (existsSync(logoOut)) console.log(`🖼  ${logoOut} — загрузить как Store logo 300×300`);
