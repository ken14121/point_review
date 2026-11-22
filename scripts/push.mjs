#!/usr/bin/env node
/**
 * 42 API を叩いて集計し、結果だけをデプロイ済みの Worker へ送る。
 *
 * 42 は Cloudflare のエッジやデータセンター IP からのアクセスを bot チャレンジで
 * 弾く（403）ので、Worker から直接は叩けない。このスクリプトを 42 が受け入れる
 * ネットワーク（自分の PC）で動かし、Worker は受け取った数字を配るだけにする。
 *
 *   node scripts/push.mjs
 *
 * 設定は .dev.vars か環境変数から読む:
 *   FT_CLIENT_ID, FT_CLIENT_SECRET   42 の OAuth アプリ
 *   PUSH_URL                         例 https://point-review.kendayo1412.workers.dev
 *   PUSH_TOKEN                       Worker 側の PUSH_TOKEN と同じ合言葉
 *   REVIEW_DAYS                      時間別の件数を何日ぶん持つか（既定 14）
 *   POOLS                            例 "september:2025,august:2026"（既定 september:2025）
 *   CAMPUS_ID / CURSUS_ID / PISCINE_CURSUS_ID   既定 26 / 21 / 9
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = join(ROOT, ".push-state.json");
const API = "https://api.intra.42.fr";
const HOUR_MS = 3600000;

// ---- 設定の読み込み ---------------------------------------------------------

async function loadConfig() {
  const config = { ...process.env };
  try {
    const text = await readFile(join(ROOT, ".dev.vars"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (match && !config[match[1]]) config[match[1]] = match[2];
    }
  } catch { /* .dev.vars が無くても環境変数だけで動く */ }
  return config;
}

function required(config, name) {
  const value = config[name];
  if (!value) {
    console.error(`${name} が設定されていません（.dev.vars か環境変数に入れてください）`);
    process.exit(1);
  }
  return value;
}

// ---- 42 API -----------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 2 req/秒 を超えないように間隔を空ける。 */
let lastCallAt = 0;
async function paced() {
  const wait = lastCallAt + 520 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

async function getToken(config) {
  await paced();
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: required(config, "FT_CLIENT_ID"),
      client_secret: required(config, "FT_CLIENT_SECRET"),
    }),
  });
  if (!res.ok) {
    console.error(`トークン取得に失敗しました (HTTP ${res.status})`);
    if (res.status === 401) console.error("  → UID か Secret が違います。intra のアプリページの現在値を確認してください");
    if (res.status === 403) console.error("  → 42 側に bot 扱いされています。このネットワークからは叩けません");
    process.exit(1);
  }
  return (await res.json()).access_token;
}

async function api(token, path, searchParams = {}, retry = true) {
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, String(value));
  await paced();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429 && retry) {
    console.warn("  レート制限。5 秒待って再試行します");
    await sleep(5000);
    return api(token, path, searchParams, false);
  }
  if (!res.ok) throw new Error(`42 API ${res.status}: ${path}`);
  return { res, body: await res.json() };
}

async function apiAll(token, path, searchParams = {}, maxPages = 30) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const { res, body } = await api(token, path, { ...searchParams, "page[size]": 100, "page[number]": page });
    if (!Array.isArray(body)) throw new Error(`配列が返りませんでした: ${path}`);
    rows.push(...body);
    const total = Number(res.headers.get("x-total"));
    if (body.length < 100) break;
    if (Number.isFinite(total) && rows.length >= total) break;
  }
  return rows;
}

async function countReviews(token, campusId, fromMs, toMs) {
  const { res } = await api(token, "/v2/scale_teams", {
    "filter[campus_id]": campusId,
    "range[filled_at]": `${new Date(fromMs).toISOString()},${new Date(toMs).toISOString()}`,
    "page[size]": 1,
  });
  const total = Number(res.headers.get("x-total"));
  if (!Number.isFinite(total)) throw new Error("x-total が取れませんでした");
  return total;
}

// ---- 送信 -------------------------------------------------------------------

async function push(config, key, data) {
  const base = required(config, "PUSH_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/api/push?key=${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${required(config, "PUSH_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`push 失敗 ${key}: HTTP ${res.status} ${text.slice(0, 200)}`);
  console.log(`  送信 ${key}`);
}

// ---- 集計 -------------------------------------------------------------------

/** 時間ごとのレビュー件数。前回ぶんは state から引き継ぎ、新しい時間だけ取る。 */
async function buildReviewSeries(token, config, state) {
  const campusId = config.CAMPUS_ID || "26";
  const days = Number(config.REVIEW_DAYS || 14);
  const nowHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const firstHour = nowHour - days * 24 * HOUR_MS;

  const known = new Map(state.series || []);
  // 窓から外れた古い分は捨てる
  for (const hourISO of [...known.keys()]) {
    if (Date.parse(hourISO) < firstHour) known.delete(hourISO);
  }

  const missing = [];
  for (let hour = firstHour; hour < nowHour; hour += HOUR_MS) {
    const hourISO = new Date(hour).toISOString();
    // 直近 1 時間は確定していないので毎回取り直す
    if (!known.has(hourISO) || hour >= nowHour - HOUR_MS) missing.push(hour);
  }

  if (missing.length) {
    const minutes = Math.ceil((missing.length * 0.52) / 60);
    console.log(`時間別の件数: ${missing.length} 時間ぶんを取得します（約 ${minutes} 分）`);
  } else {
    console.log("時間別の件数: 新しく取る時間はありません");
  }

  let done = 0;
  for (const hour of missing) {
    const hourISO = new Date(hour).toISOString();
    known.set(hourISO, await countReviews(token, campusId, hour, hour + HOUR_MS));
    done += 1;
    if (done % 24 === 0 || done === missing.length) {
      process.stdout.write(`\r  ${done} / ${missing.length}`);
    }
  }
  if (missing.length) process.stdout.write("\n");

  const series = [...known.entries()].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  return {
    from: new Date(firstHour).toISOString(),
    to: new Date(nowHour).toISOString(),
    series,
  };
}

function isCurrentEnrollment(candidate, previous) {
  if (!candidate.endAt !== !previous.endAt) return !candidate.endAt;
  const a = Date.parse(candidate.beginAt ?? "") || 0;
  const b = Date.parse(previous.beginAt ?? "") || 0;
  if (a !== b) return a > b;
  return candidate.level > previous.level;
}

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function fetchPisciners(token, campusId, month, year) {
  return apiAll(token, `/v2/campus/${campusId}/users`, {
    "filter[pool_month]": month,
    "filter[pool_year]": year,
  });
}

async function buildCohort(token, config, month, year) {
  const campusId = config.CAMPUS_ID || "26";
  const cursusId = config.CURSUS_ID || "21";
  const pisciners = await fetchPisciners(token, campusId, month, year);
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
      grade: row.grade || null,
      beginAt: row.begin_at || null,
      endAt: row.end_at || null,
      blackholedAt: row.blackholed_at || null,
    };
    const previous = byUser.get(userId);
    if (!previous || isCurrentEnrollment(member, previous)) byUser.set(userId, member);
  }
  const members = [...byUser.values()].sort((a, b) => b.level - a.level || a.login.localeCompare(b.login));
  return { pisciners: pisciners.length, members, duplicateRows: rows.length - members.length };
}

function examOrder(exam) {
  const label = `${exam.name || ""} ${exam.slug || ""}`;
  if (/final/i.test(label)) return 99;
  const number = label.match(/(\d+)/);
  return number ? Number(number[1]) : 50;
}

async function buildExamProjects(token, config) {
  const cursusId = config.PISCINE_CURSUS_ID || "9";
  const projects = await apiAll(token, `/v2/cursus/${cursusId}/projects`, {}, 5);
  const exams = projects
    .filter((project) => /exam/i.test(`${project.name || ""} ${project.slug || ""}`))
    .map((project) => ({ id: project.id, name: project.name, slug: project.slug }))
    .sort((a, b) => examOrder(a) - examOrder(b) || a.name.localeCompare(b.name));
  const fallback = exams.find((exam) => /final/i.test(`${exam.name} ${exam.slug}`)) ?? exams[exams.length - 1];
  return { exams, defaultExamId: fallback?.id ?? null };
}

function isBetterAttempt(candidate, previous) {
  if (candidate.validated !== previous.validated) return candidate.validated === true;
  const candidateMark = candidate.mark ?? -1;
  const previousMark = previous.mark ?? -1;
  if (candidateMark !== previousMark) return candidateMark > previousMark;
  return (Date.parse(candidate.markedAt ?? "") || 0) > (Date.parse(previous.markedAt ?? "") || 0);
}

async function buildExam(token, config, month, year, projectId) {
  const campusId = config.CAMPUS_ID || "26";
  const cursusId = config.CURSUS_ID || "21";
  const pisciners = await fetchPisciners(token, campusId, month, year);
  const usersById = new Map(pisciners.map((user) => [user.id, user]));

  const rows = [];
  // 本科（42cursus）に在籍が始まった人。試験の validated? とは別物。
  const admitted = new Set();
  for (const ids of chunk([...usersById.keys()], 30)) {
    rows.push(...(await apiAll(token, `/v2/projects/${projectId}/projects_users`, { "filter[user_id]": ids.join(",") }, 3)));
    for (const row of await apiAll(token, `/v2/cursus/${cursusId}/cursus_users`, { "filter[user_id]": ids.join(",") }, 2)) {
      const id = row.user?.id ?? row.user_id;
      if (id !== undefined && id !== null) admitted.add(id);
    }
  }

  const byUser = new Map();
  for (const row of rows) {
    const user = row.user || (row.user_id ? usersById.get(row.user_id) : null);
    const userId = user?.id ?? row.user_id;
    const attempt = {
      login: user?.login ?? `#${userId}`,
      mark: row.final_mark === null || row.final_mark === undefined ? null : Number(row.final_mark),
      validated: row["validated?"] ?? null,
      admitted: admitted.has(userId),
      status: row.status || null,
      markedAt: row.marked_at || null,
      occurrence: row.occurrence ?? null,
    };
    const previous = byUser.get(userId);
    if (!previous || isBetterAttempt(attempt, previous)) byUser.set(userId, attempt);
  }
  const attempts = [...byUser.values()].sort((a, b) => (b.mark ?? -1) - (a.mark ?? -1) || a.login.localeCompare(b.login));
  return { pisciners: pisciners.length, attempts, duplicateRows: rows.length - attempts.length };
}

// ---- 本体 -------------------------------------------------------------------

async function main() {
  const config = await loadConfig();
  const pools = (config.POOLS || "september:2025")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [month, year] = entry.split(":");
      return { month: (month || "").toLowerCase(), year: (year || "").trim() };
    });

  let state = { series: [] };
  try {
    state = JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch { /* 初回は空から */ }

  console.log(`送り先: ${config.PUSH_URL}`);
  const token = await getToken(config);
  console.log("トークン取得 OK");

  const reviews = await buildReviewSeries(token, config, state);
  await push(config, "reviews-hourly", reviews);
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ series: reviews.series }), "utf8");

  const examProjects = await buildExamProjects(token, config);
  await push(config, "exam-projects", examProjects);
  console.log(`試験プロジェクト: ${examProjects.exams.length} 件`);

  for (const { month, year } of pools) {
    console.log(`${year} 年 ${month} ピシン:`);
    const cohort = await buildCohort(token, config, month, year);
    await push(config, `cohort:${month}:${year}`, cohort);
    console.log(`  同期 ${cohort.members.length} 人`);

    for (const exam of examProjects.exams) {
      const result = await buildExam(token, config, month, year, exam.id);
      await push(config, `exam:${month}:${year}:${exam.id}`, result);
      console.log(`  ${exam.name}: ${result.attempts.length} 人`);
    }
  }

  console.log("完了");
}

main().catch((err) => {
  console.error("\n失敗:", err.message);
  process.exit(1);
});
