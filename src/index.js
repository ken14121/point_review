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
      fetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
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

/** 期間内に filled_at が入った scale_teams の件数を x-total から読む。 */
async function fetchTotal(env, fromISO, toISO, allowRetry = true) {
  const token = await getToken(env);
  const url = new URL(SCALE_TEAMS_URL);
  url.searchParams.set("filter[campus_id]", String(env.CAMPUS_ID || "26"));
  url.searchParams.set("range[filled_at]", `${fromISO},${toISO}`);
  url.searchParams.set("page[size]", "1");

  const res = await limited(() => fetch(url, { headers: { authorization: `Bearer ${token}` } }));

  if (res.status === 401 && allowRetry) {
    tokenCache = null;
    return fetchTotal(env, fromISO, toISO, false);
  }
  if (res.status === 429) {
    throw new HttpError(429, "42 API のレート制限に達しました。少し待ってから再試行してください");
  }
  if (!res.ok) {
    throw new HttpError(502, `42 API がエラーを返しました (HTTP ${res.status})`);
  }

  const total = Number(res.headers.get("x-total"));
  if (!Number.isFinite(total)) {
    throw new HttpError(502, "x-total ヘッダが取得できませんでした");
  }
  return total;
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

    try {
      switch (url.pathname) {
        case "/api/config":
          return handleConfig(env, ctx);
        case "/api/count":
          return await handleCount(request, env);
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
