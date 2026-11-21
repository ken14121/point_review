#!/usr/bin/env node
/**
 * どの月にピシンがあったか（出身者が何人いるか）を一覧する。
 *
 *   node scripts/pools.mjs 2026
 *   node scripts/pools.mjs 2025 2026
 *
 * 人数は x-total ヘッダから読むので 1 月につき 1 リクエストで済む。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.intra.42.fr";
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

async function loadConfig() {
  const config = { ...process.env };
  try {
    const text = await readFile(join(ROOT, ".dev.vars"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (match && !config[match[1]]) config[match[1]] = match[2];
    }
  } catch { /* 環境変数だけでも動く */ }
  return config;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCallAt = 0;
async function paced() {
  const wait = lastCallAt + 520 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function getToken(config) {
  if (!config.FT_CLIENT_ID || !config.FT_CLIENT_SECRET) {
    console.error("FT_CLIENT_ID / FT_CLIENT_SECRET が .dev.vars にありません");
    process.exit(1);
  }
  await paced();
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.FT_CLIENT_ID,
      client_secret: config.FT_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    console.error(`トークン取得に失敗 (HTTP ${res.status})`);
    process.exit(1);
  }
  return (await res.json()).access_token;
}

async function countPool(token, campusId, month, year) {
  const url = new URL(`${API}/v2/campus/${campusId}/users`);
  url.searchParams.set("filter[pool_month]", month);
  url.searchParams.set("filter[pool_year]", year);
  url.searchParams.set("page[size]", "1");
  await paced();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`42 API ${res.status}`);
  const total = Number(res.headers.get("x-total"));
  return Number.isFinite(total) ? total : 0;
}

async function main() {
  const years = process.argv.slice(2);
  if (years.length === 0) {
    console.error("使い方: node scripts/pools.mjs <年> [<年> ...]");
    console.error("  例: node scripts/pools.mjs 2025 2026");
    process.exit(1);
  }
  const config = await loadConfig();
  const campusId = config.CAMPUS_ID || "26";
  const token = await getToken(config);

  for (const year of years) {
    if (!/^20\d{2}$/.test(year)) {
      console.error(`年の指定が不正です: ${year}`);
      continue;
    }
    console.log(`\n=== ${year} 年`);
    let found = 0;
    for (const month of MONTHS) {
      const count = await countPool(token, campusId, month, year);
      if (count > 0) {
        console.log(`  ${month.padEnd(10)} ${String(count).padStart(4)} 名   （指定は ${month}:${year}）`);
        found += 1;
      }
    }
    if (found === 0) console.log("  ピシン出身者が登録されている月はありません");
  }
}

main().catch((err) => {
  console.error("\n失敗:", err.message);
  process.exit(1);
});
