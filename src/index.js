/**
 * レビュー件数カウンター — Cloudflare Worker
 *
 * 指定した期間に完了したピアレビュー (scale_teams) の件数を返す。
 * 42 API はページングされたエンドポイントで総件数を `x-total` ヘッダに返すので、
 * 1 リクエスト / 1 集計で済む（全件ページングは不要）。
 *
 * client_secret はここでしか使わない。ブラウザには集計値だけを返す。
 */

const API_ORIGIN = "https://api.intra.42.fr";
const TOKEN_URL = `${API_ORIGIN}/oauth/token`;
const SCALE_TEAMS_URL = `${API_ORIGIN}/v2/scale_teams`;

/** 42 API のレート制限は 2 req/sec。同じ枠をトークン取得と件数取得で共有する。 */
const RATE_LIMIT_PER_SEC = 2;

/** 期間指定の受け入れ範囲。 */
const EARLIEST_MS = Date.UTC(2019, 0, 1);
const MAX_SPAN_MS = 400 * 24 * 3600 * 1000;

// --- モジュールスコープの状態 -------------------------------------------------
// isolate が生きている間だけ有効な best-effort キャッシュ。消えても正しさには影響しない。

let tokenCache = null; // { token, expiresAt }
let tokenInflight = null;

const countCache = new Map(); // "from|to" -> { total, expiresAt }
const COUNT_CACHE_MAX_ENTRIES = 2000;

// トークンバケット: 1 秒あたり RATE_LIMIT_PER_SEC 件まで。
// 溜まっていれば待たずに通るので、トークン取得 + 件数取得が続けて走っても待ち時間が入らない。
let availableSlots = RATE_LIMIT_PER_SEC;
let lastRefillAt = Date.now();
let slotQueue = Promise.resolve();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function acquireSlot() {
  const waited = slotQueue.then(async () => {
    for (;;) {
      const now = Date.now();
      availableSlots = Math.min(
        RATE_LIMIT_PER_SEC,
        availableSlots + ((now - lastRefillAt) / 1000) * RATE_LIMIT_PER_SEC,
      );
      lastRefillAt = now;
      if (availableSlots >= 1) {
        availableSlots -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - availableSlots) / RATE_LIMIT_PER_SEC) * 1000));
    }
  });
  slotQueue = waited.catch(() => {});
  return waited;
}

async function limited(task) {
  await acquireSlot();
  return task();
}

/**
 * 接続自体が失敗したとき（DNS が引けない、接続が切られた等）に読めるエラーへ変える。
 * これを挟まないと workerd の内部エラーがそのまま出て "internal error; reference = ..." になる。
 */
async function reachable(task) {
  try {
    return await task();
  } catch (err) {
    throw new HttpError(502, `42 API に接続できませんでした（${err?.message || "ネットワークエラー"}）`);
  }
}

async function getToken(env) {
  if (!env.FT_CLIENT_ID || !env.FT_CLIENT_SECRET) {
    throw new HttpError(500, "FT_CLIENT_ID / FT_CLIENT_SECRET が設定されていません");
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (tokenInflight) return tokenInflight;

  const pending = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.FT_CLIENT_ID,
      client_secret: env.FT_CLIENT_SECRET,
    });
    const res = await limited(() =>
      reachable(() =>
        fetch(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      ),
    );
    if (!res.ok) {
      throw new HttpError(502, `42 のトークン取得に失敗しました (HTTP ${res.status})`);
    }
    const json = await res.json();
    if (!json.access_token) throw new HttpError(502, "access_token がレスポンスにありません");
    // 期限の 1 分前に切れた扱いにして、境界での 401 を避ける。
    const ttlMs = (Number(json.expires_in) || 7200) * 1000;
    tokenCache = { token: json.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
    return tokenCache.token;
  })();

  tokenInflight = pending;
  pending
    .catch(() => {})
    .then(() => {
      if (tokenInflight === pending) tokenInflight = null;
    });
  return pending;
}

/** 42 API への GET。401 のときだけトークンを取り直して 1 回やり直す。 */
async function fetch42(env, url, allowRetry = true) {
  const token = await getToken(env);
  const res = await limited(() =>
    reachable(() => fetch(url, { headers: { authorization: `Bearer ${token}` } })),
  );

  if (res.status === 401 && allowRetry) {
    tokenCache = null;
    return fetch42(env, url, false);
  }
  if (res.status === 429) {
    throw new HttpError(429, "42 API のレート制限に達しました。少し待ってから再試行してください");
  }
  if (!res.ok) {
    throw new HttpError(502, `42 API がエラーを返しました (HTTP ${res.status}: ${url.pathname})`);
  }
  return res;
}

/** x-total を見ながら最後のページまで読む。 */
async function fetchAllPages(env, baseUrl, { pageSize = 100, maxPages = 30 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set("page[size]", String(pageSize));
    url.searchParams.set("page[number]", String(page));
    const res = await fetch42(env, url);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new HttpError(502, "配列が返ってきませんでした");
    rows.push(...batch);
    const total = Number(res.headers.get("x-total"));
    if (batch.length < pageSize) break;
    if (Number.isFinite(total) && rows.length >= total) break;
  }
  return rows;
}

/** 期間内に filled_at が入った scale_teams の件数を x-total から読む。 */
async function fetchTotal(env, fromISO, toISO) {
  const url = new URL(SCALE_TEAMS_URL);
  url.searchParams.set("filter[campus_id]", String(env.CAMPUS_ID || "26"));
  url.searchParams.set("range[filled_at]", `${fromISO},${toISO}`);
  url.searchParams.set("page[size]", "1");

  const res = await fetch42(env, url);
  const total = Number(res.headers.get("x-total"));
  if (!Number.isFinite(total)) {
    throw new HttpError(502, "x-total ヘッダが取得できませんでした");
  }
  return total;
}

const POOL_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * 指定したピシン出身者の cursus 進捗を集める。
 *
 * cursus_users 側に pool フィルタがあるかは確かめられていないので、確実にある経路だけを使う:
 *   1. /v2/campus/:id/users を pool_month + pool_year で絞ってピシン出身者を取る
 *   2. その user_id をまとめて /v2/cursus/:id/cursus_users に渡す（カンマ区切りで複数指定）
 * 150 人なら 2 + 5 リクエスト程度で済む。
 */
async function fetchCohort(env, poolMonth, poolYear) {
  const campusId = String(env.CAMPUS_ID || "26");
  const cursusId = String(env.CURSUS_ID || "21");

  const usersUrl = new URL(`${API_ORIGIN}/v2/campus/${campusId}/users`);
  usersUrl.searchParams.set("filter[pool_month]", poolMonth);
  usersUrl.searchParams.set("filter[pool_year]", poolYear);
  const pisciners = await fetchAllPages(env, usersUrl);

  const usersById = new Map(pisciners.map((user) => [user.id, user]));
  const rows = [];
  for (const ids of chunk([...usersById.keys()], 30)) {
    const cursusUrl = new URL(`${API_ORIGIN}/v2/cursus/${cursusId}/cursus_users`);
    cursusUrl.searchParams.set("filter[user_id]", ids.join(","));
    rows.push(...(await fetchAllPages(env, cursusUrl, { maxPages: 2 })));
  }

  // 同じ人が cursus_users を複数持つことがある（再登録・キャンパス移動など）。
  // 古いほうを採ると期限やレベルが実際とずれるので、1 人 1 行に絞る。
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

  const members = [...byUser.values()];
  members.sort((a, b) => b.level - a.level || a.login.localeCompare(b.login));

  return {
    pisciners: pisciners.length,
    members,
    // 重複があったかどうかを見えるようにしておく（0 でなければ複数登録の人がいる）
    duplicateRows: rows.length - members.length,
  };
}

/** 同じ人の 2 行のうち、今の在籍を表しているほうを選ぶ。 */
function isCurrentEnrollment(candidate, previous) {
  // 終了していない登録が最優先
  if (!candidate.endAt !== !previous.endAt) return !candidate.endAt;
  // 次に、開始が新しいほう
  const candidateBegin = Date.parse(candidate.beginAt ?? "") || 0;
  const previousBegin = Date.parse(previous.beginAt ?? "") || 0;
  if (candidateBegin !== previousBegin) return candidateBegin > previousBegin;
  // 最後にレベルが高いほう
  return candidate.level > previous.level;
}

function cacheGet(key) {
  const hit = countCache.get(key);
  if (!hit) return null;
  if (Date.now() >= hit.expiresAt) {
    countCache.delete(key);
    return null;
  }
  return hit.total;
}

function cacheSet(key, total, endMs) {
  // 完全に過去の期間は結果が変わらないので長めに、現在を含む期間は短く。
  const isSettled = endMs < Date.now() - 60_000;
  const ttl = isSettled ? 12 * 3600_000 : 60_000;
  if (countCache.size >= COUNT_CACHE_MAX_ENTRIES) {
    // 単純な FIFO の間引き。Map は挿入順を保つ。
    for (const key of countCache.keys()) {
      countCache.delete(key);
      if (countCache.size < COUNT_CACHE_MAX_ENTRIES * 0.9) break;
    }
  }
  countCache.set(key, { total, expiresAt: Date.now() + ttl });
}

function parseRange(url) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) throw new HttpError(400, "from と to は必須です");

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new HttpError(400, "from / to は ISO 8601 形式で指定してください");
  }
  if (fromMs >= toMs) throw new HttpError(400, "開始は終了より前である必要があります");
  if (fromMs < EARLIEST_MS) throw new HttpError(400, "開始が古すぎます");
  if (toMs - fromMs > MAX_SPAN_MS) throw new HttpError(400, "期間が長すぎます（最長 400 日）");

  return {
    fromMs,
    toMs,
    fromISO: new Date(fromMs).toISOString(),
    toISO: new Date(toMs).toISOString(),
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

async function handleCount(request, env) {
  const url = new URL(request.url);
  const { toMs, fromISO, toISO } = parseRange(url);
  const key = `${fromISO}|${toISO}`;

  const cached = cacheGet(key);
  if (cached !== null) {
    return json({ from: fromISO, to: toISO, total: cached, cached: true });
  }

  const total = await fetchTotal(env, fromISO, toISO);
  cacheSet(key, total, toMs);
  return json({ from: fromISO, to: toISO, total, cached: false });
}

async function handleCohort(request, env) {
  const url = new URL(request.url);
  const poolMonth = (url.searchParams.get("pool_month") || "september").toLowerCase();
  const poolYear = url.searchParams.get("pool_year") || "2025";

  if (!POOL_MONTHS.includes(poolMonth)) {
    throw new HttpError(400, `pool_month が不正です（${POOL_MONTHS.join(", ")} のいずれか）`);
  }
  if (!/^20\d{2}$/.test(poolYear)) {
    throw new HttpError(400, "pool_year は 4 桁の西暦で指定してください");
  }

  const key = `cohort|${poolMonth}|${poolYear}`;
  const cached = cacheGet(key);
  if (cached !== null) return json({ poolMonth, poolYear, ...cached, cached: true });

  const cohort = await fetchCohort(env, poolMonth, poolYear);
  // 進捗はそう速く動かないので 10 分持たせる。
  countCache.set(key, { total: cohort, expiresAt: Date.now() + 600_000 });
  return json({ poolMonth, poolYear, ...cohort, cached: false });
}

/** デバッグ用の経路はローカル開発のときだけ開ける（本番では 404）。 */
function isLocalRequest(url) {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

/**
 * 答え合わせ用。指定した login の cursus_users を 42 API から取り、加工せずそのまま返す。
 * こちらでフィールドを選ぶと、選んでいない項目（マイルストーンの期限など）を
 * 見落とすので、生のまま出す。
 */
async function handleDebugUser(request, env) {
  const login = (new URL(request.url).searchParams.get("login") || "").trim();
  if (!/^[a-z0-9_-]{2,32}$/i.test(login)) {
    throw new HttpError(400, "login を指定してください（英数字・ハイフン・アンダースコア）");
  }
  const url = new URL(`${API_ORIGIN}/v2/users/${encodeURIComponent(login)}/cursus_users`);
  url.searchParams.set("page[size]", "100");
  const rows = await (await fetch42(env, url)).json();
  const cursusId = Number(env.CURSUS_ID || "21");
  const target = (Array.isArray(rows) ? rows : []).find((row) => row.cursus_id === cursusId);
  return json({
    login,
    now: new Date().toISOString(),
    cursusIdInUse: cursusId,
    // 42cursus の行にどんなキーがあるか（マイルストーン関連を探すため）
    keysOnTargetRow: target ? Object.keys(target).sort() : [],
    rows,
  });
}

/**
 * 42 API の任意の GET を素通しする（ローカル限定）。
 * マイルストーンの期限がどのエンドポイントにあるかを探すために使う。
 */
async function handleDebugRaw(request, env) {
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!path.startsWith("/v2/") || path.includes("..")) {
    throw new HttpError(400, "path は /v2/ で始まるものを指定してください");
  }
  const url = new URL(API_ORIGIN + path);
  return json({ path, body: await (await fetch42(env, url)).json() });
}

function handleConfig(env, ctx) {
  // 最初の集計がトークン取得を待たなくて済むよう、ここで裏で温めておく。
  if (!tokenCache && env.FT_CLIENT_ID && env.FT_CLIENT_SECRET) {
    ctx.waitUntil(getToken(env).catch(() => {}));
  }
  return json({
    campusId: Number(env.CAMPUS_ID || 26),
    campusName: env.CAMPUS_NAME || "42Tokyo",
    timeZone: env.CAMPUS_TZ || "Asia/Tokyo",
    // 空なら UI 側で「直近 7 日」を初期値にする
    saleStart: env.SALE_START || "",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // 静的アセットに一致しなかったパス。ページ遷移だけトップへ送り、
      // favicon.ico のようなサブリソース要求には HTML を返さず 404 にする。
      if (!(request.headers.get("accept") || "").includes("text/html")) {
        return new Response("not found", { status: 404 });
      }
      return Response.redirect(new URL("/", url).toString(), 302);
    }
    if (request.method !== "GET") {
      return json({ error: "GET のみ対応しています" }, 405);
    }
    if (url.pathname.startsWith("/api/debug/") && !isLocalRequest(url)) {
      return json({ error: "not found" }, 404);
    }

    try {
      switch (url.pathname) {
        case "/api/config":
          return handleConfig(env, ctx);
        case "/api/count":
          return await handleCount(request, env);
        case "/api/cohort":
          return await handleCohort(request, env);
        case "/api/debug/user":
          return await handleDebugUser(request, env);
        case "/api/debug/raw":
          return await handleDebugRaw(request, env);
        case "/api/health":
          return json({ ok: true });
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || "internal error" }, status);
    }
  },
};
