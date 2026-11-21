#!/usr/bin/env node
/**
 * 42 API のパスを順に叩いて、あるかどうかだけ確かめる。
 *
 *   node scripts/probe.mjs                       フリーズ関連の候補をまとめて試す
 *   node scripts/probe.mjs /v2/achievements ...  任意のパスを試す
 *
 * 200 なら中身の先頭も出す。404 はそのパスが無いという意味。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.intra.42.fr";

// 既定の候補。USER / CURSUS_USER は下で実際の値に置き換える。
const FREEZE_CANDIDATES = [
  "/v2/freezes",
  "/v2/freezes?filter[user_id]=USER",
  "/v2/users/USER/freezes",
  "/v2/campus/CAMPUS/freezes",
  "/v2/cursus_users/CURSUS_USER/freezes",
  "/v2/users/USER/freezes_users",
  "/v2/freezes_users?filter[user_id]=USER",
  "/v2/users/USER/locations",
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

/** login から user_id と 42cursus の cursus_user_id を引く。 */
async function resolveIds(token, login, cursusId) {
  await paced();
  const res = await fetch(`${API}/v2/users/${encodeURIComponent(login)}/cursus_users`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { userId: null, cursusUserId: null };
  const rows = await res.json();
  const target = rows.find((row) => String(row.cursus_id) === String(cursusId)) ?? rows[0];
  return { userId: target?.user?.id ?? null, cursusUserId: target?.id ?? null };
}

async function main() {
  const config = await loadConfig();
  const campusId = config.CAMPUS_ID || "26";
  const cursusId = config.CURSUS_ID || "21";
  const login = config.PROBE_LOGIN || "ksadayas";
  const token = await getToken(config);

  const { userId, cursusUserId } = await resolveIds(token, login, cursusId);
  console.log(`基準にする人: ${login}（user_id ${userId ?? "?"} / cursus_user_id ${cursusUserId ?? "?"}）`);
  if (!userId) console.log("  ※ id が引けませんでした。PROBE_LOGIN を指定してください");

  const paths = process.argv.slice(2).length
    ? process.argv.slice(2)
    : FREEZE_CANDIDATES.map((path) =>
        path
          .replace("USER", String(userId ?? ""))
          .replace("CAMPUS", campusId)
          .replace("CURSUS_USER", String(cursusUserId ?? "")),
      );

  console.log("");
  for (const path of paths) {
    await paced();
    let line = `  ${String(path).padEnd(46)} `;
    try {
      const res = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
      line += `${res.status}`;
      if (res.ok) {
        const text = await res.text();
        const trimmed = text.trim();
        line += trimmed === "[]" ? "  （空の配列）" : `  ${trimmed.slice(0, 160)}`;
      }
    } catch (err) {
      line += `失敗 ${err.message}`;
    }
    console.log(line);
  }

  console.log("\n404 はそのパスが無いという意味です。200 で中身があるものが見つかれば、そこが当たりです。");
}

main().catch((err) => {
  console.error("\n失敗:", err.message);
  process.exit(1);
});
