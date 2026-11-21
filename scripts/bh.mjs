#!/usr/bin/env node
/**
 * 指定したピシン出身者の blackholed_at を、期限の近い順に並べて出す。
 *
 *   node scripts/bh.mjs september:2026
 *   node scripts/bh.mjs august:2026 september:2026
 *   node scripts/bh.mjs september:2026 --days 60     期限 60 日以内だけ
 *
 * 注意: ここで出る日付は 42 API の cursus_users.blackholed_at。
 * intra のダッシュボードに出る "Milestone Ultimate Deadline" とは別物で、
 * ある学生では 85 日ずれていた。順番の目安にはなるが、残り日数は intra と一致しない。
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.intra.42.fr";
const DAY_MS = 86400000;

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
    if (res.status === 401) console.error("  → UID か Secret が違います");
    if (res.status === 403) console.error("  → このネットワークからは 42 に bot 扱いされています");
    process.exit(1);
  }
  return (await res.json()).access_token;
}

async function apiAll(token, path, searchParams = {}, maxPages = 30) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(API + path);
    for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, String(value));
    url.searchParams.set("page[size]", "100");
    url.searchParams.set("page[number]", String(page));
    await paced();
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`42 API ${res.status}: ${path}`);
    const body = await res.json();
    rows.push(...body);
    const total = Number(res.headers.get("x-total"));
    if (body.length < 100) break;
    if (Number.isFinite(total) && rows.length >= total) break;
  }
  return rows;
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

function isCurrentEnrollment(candidate, previous) {
  if (!candidate.endAt !== !previous.endAt) return !candidate.endAt;
  const a = Date.parse(candidate.beginAt ?? "") || 0;
  const b = Date.parse(previous.beginAt ?? "") || 0;
  if (a !== b) return a > b;
  return candidate.level > previous.level;
}

async function cohortOf(token, config, month, year) {
  const campusId = config.CAMPUS_ID || "26";
  const cursusId = config.CURSUS_ID || "21";
  const pisciners = await apiAll(token, `/v2/campus/${campusId}/users`, {
    "filter[pool_month]": month,
    "filter[pool_year]": year,
  });
  const usersById = new Map(pisciners.map((user) => [user.id, user]));

  const rows = [];
  for (const ids of chunk([...usersById.keys()], 30)) {
    rows.push(...(await apiAll(token, `/v2/cursus/${cursusId}/cursus_users`, { "filter[user_id]": ids.join(",") }, 2)));
  }

  const byUser = new Map();
  for (const row of rows) {
    const user = row.user || usersById.get(row.user_id);
    const userId = user?.id ?? row.user_id;
    const member = {
      login: user?.login ?? `#${userId}`,
      level: Number(row.level) || 0,
      beginAt: row.begin_at || null,
      endAt: row.end_at || null,
      blackholedAt: row.blackholed_at || null,
    };
    const previous = byUser.get(userId);
    if (!previous || isCurrentEnrollment(member, previous)) byUser.set(userId, member);
  }
  return { pisciners: pisciners.length, members: [...byUser.values()] };
}

function render(label, cohort, limitDays) {
  const now = Date.now();
  const withDeadline = cohort.members
    .filter((member) => member.blackholedAt)
    .map((member) => ({ ...member, days: Math.ceil((Date.parse(member.blackholedAt) - now) / DAY_MS) }))
    .sort((a, b) => a.days - b.days);

  const reached = withDeadline.filter((member) => member.days <= 0);
  const upcoming = withDeadline.filter((member) => member.days > 0);
  const soon = limitDays === null ? upcoming : upcoming.filter((member) => member.days <= limitDays);
  const noDeadline = cohort.members.length - withDeadline.length;

  console.log(`\n=== ${label}`);
  console.log(`  ピシン参加者 ${cohort.pisciners} 名 / 42cursus 在籍 ${cohort.members.length} 名`);
  console.log(`  期限到達済み ${reached.length} 名 / 期限なし ${noDeadline} 名`);
  console.log(`  ${limitDays === null ? "期限あり" : `期限 ${limitDays} 日以内`} ${soon.length} 名`);
  if (soon.length === 0) return;
  console.log("");
  console.log("    残り  期限        レベル  login");
  for (const member of soon) {
    console.log(
      `    ${String(member.days).padStart(4)}日  ${member.blackholedAt.slice(0, 10)}  ` +
      `${member.level.toFixed(2).padStart(6)}  ${member.login}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const daysIndex = args.indexOf("--days");
  let limitDays = null;
  if (daysIndex !== -1) {
    limitDays = Number(args[daysIndex + 1]);
    args.splice(daysIndex, 2);
    if (!Number.isFinite(limitDays)) {
      console.error("--days には数値を指定してください");
      process.exit(1);
    }
  }
  if (args.length === 0) {
    console.error("使い方: node scripts/bh.mjs <月>:<年> [<月>:<年> ...] [--days 60]");
    console.error("  例: node scripts/bh.mjs august:2026 september:2026 --days 60");
    process.exit(1);
  }

  const config = await loadConfig();
  const token = await getToken(config);

  for (const spec of args) {
    const [month, year] = spec.split(":");
    if (!month || !year) {
      console.error(`指定が不正です: ${spec}（例 september:2026）`);
      continue;
    }
    const cohort = await cohortOf(token, config, month.toLowerCase(), year);
    render(`Piscine ${month} ${year}`, cohort, limitDays);
  }

  console.log(
    "\n※ 日付は 42 API の cursus_users.blackholed_at です。" +
    "intra の Milestone Ultimate Deadline とは別物で、ある学生では 85 日ずれていました。" +
    "\n  並び順の目安にはなりますが、残り日数は intra の表示と一致しません。",
  );
}

main().catch((err) => {
  console.error("\n失敗:", err.message);
  process.exit(1);
});
