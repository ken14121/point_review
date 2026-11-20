# point_review

42Tokyo内部のエバポセール実施中のレビュー件数をapiから入手して課題提出を手助けする

指定した期間に **42 のキャンパスで完了したピアレビュー（scale_teams）が何件あったか** を数えて表示する
Cloudflare Workers のサイトです。エヴァポイントセールの開始時刻を入れれば、
「セール開始後に何件レビューが行われたか」がそのまま出ます。

## ページ

| パス | 中身 |
|---|---|
| `/` | レビュー件数カウンター（期間を指定して scale_teams の件数を数える） |
| `/cohort/` | ピシン同期の進捗（レベルの分布と一覧） |
| `/exam/` | ピシン試験の結果（点数の分布と合否の一覧） |

## 公開運用（push 方式）

42 API は Cloudflare のエッジやデータセンターの IP からのアクセスを bot チャレンジで
弾く（403）。実際に、デプロイした Worker から `/oauth/token` を叩くと 403 が返る。
そこで **42 を叩くのは自分の PC**、**Worker は受け取った数字を配るだけ**に分ける。

```
PC (scripts/push.mjs) ──42 API──▶ 集計 ──PUT /api/push──▶ Worker ──▶ KV
                                                   スマホ ──GET──▶ Worker ──▶ KV の数字
```

読み出しは保存済みがあればそれを返し、無ければ直接 42 を叩く。
つまり**ローカル開発（`npm run dev`）はこれまでどおり生の API を見る**。

### 1 回だけの準備

1. Cloudflare のダッシュボードで **KV namespace** を作る（Storage & Databases → KV）
2. その ID を `wrangler.jsonc` の `kv_namespaces` に入れる（binding 名は `DATA`）
3. Worker の **Settings → Runtime variables and secrets** に `PUSH_TOKEN` を **Secret** で追加
   （値は適当な長いランダム文字列。PC 側と同じものを使う）
4. PC の `.dev.vars` に次を足す

```
PUSH_URL="https://point-review.<あなた>.workers.dev"
PUSH_TOKEN="<上と同じ文字列>"
```

### 更新

```bash
node scripts/push.mjs
```

- 時間ごとのレビュー件数（既定 14 日ぶん）、同期の進捗、試験の結果をまとめて送る
- 2 回目以降は**新しい時間ぶんだけ**取るので数十秒で終わる（初回は 14 日ぶんで約 3 分）
- 対象のピシンは `POOLS` で指定する。例 `POOLS="september:2025,august:2026"`
- 日数は `REVIEW_DAYS` で変えられる

Windows のタスクスケジューラなどで 1 時間ごとに走らせれば、サイトは放っておいても更新される。

## 仕組み

42 API はページングされたエンドポイントで総件数を `x-total` ヘッダに返すので、
**件数を取るのに全件ページングは不要**（1 集計 = 1 リクエスト）です。

```
GET /v2/scale_teams
  ?filter[campus_id]=26
  &range[filled_at]=<開始>,<終了>
  &page[size]=1
→ x-total: 5616
```

`filled_at`（レビューが完了した時刻）が基準なので、開始済みで未完了のレビューは数に入りません。

- Worker（`src/index.js`）が client credentials でトークンを取り、集計値だけをブラウザに返します。
  `client_secret` はブラウザに一切渡りません。
- 42 API のレート制限（2 req/秒・1200 req/時）にはトークンバケットで合わせています。
  枠が溜まっていれば待たずに通るので、トークン取得と件数取得が連続しても待ち時間が入りません。
- 最初の `/api/config` でトークンを裏で温めるため、1 回目の集計がトークン取得を待ちません。
- トークンと集計結果は isolate のメモリにキャッシュします（過去の期間は 12 時間、現在を含む期間は 60 秒）。
  消えても正しさには影響しません。
- 内訳は 1 区間 = 1 リクエストなので、必要なときだけボタンで取得します（最大 62 区間、
  62 日を超える期間は自動で週単位に切り替わります）。

## エンドポイント

| | |
|---|---|
| `GET /api/count?from=<ISO>&to=<ISO>` | 期間内の件数 `{ from, to, total, cached }` |
| `GET /api/config` | キャンパス情報とセール開始の既定値 |
| `GET /api/health` | 疎通確認 |

## セットアップ

### 1. 42 の OAuth アプリを作る

https://profile.intra.42.fr/oauth/applications/new

| 欄 | 値 |
|---|---|
| Name | 任意（ユニーク必須） |
| Description | 集計しか出さないこと・個人データを保存しないことを書く |
| Application type | Create statistics |
| Redirect URI | `http://localhost:8787/callback`（client credentials のみ使うので実際には未使用） |
| Scopes | `public`（`/v2/scale_teams` が 403 なら `projects` を追加） |

### 2. Node と依存を入れる

wrangler は **Node.js 22 以上**が必要です。42 の iMac は Node 12 なので nvm で入れます。

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
```

### 3. 認証情報を入れて起動

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

http://localhost:8787/ を開きます。

本番:

```bash
npx wrangler secret put FT_CLIENT_ID
npx wrangler secret put FT_CLIENT_SECRET
npm run deploy
```

**`client_secret` をリポジトリやフロントエンドに置かないこと。** 漏らした場合は
アプリを Destroy して作り直すのが確実です（intra には手動の再発行ボタンがありません）。

### 4. キャンパスとセール開始（任意）

`wrangler.jsonc` の `vars` で設定します。

| 変数 | 既定 | 意味 |
|---|---|---|
| `CAMPUS_ID` | `26` | 42Tokyo。他キャンパスは `/v2/campus?page[size]=100` で調べる |
| `CAMPUS_NAME` | `42Tokyo` | 画面の表示名 |
| `CURSUS_ID` | `21` | 42cursus。`/v2/cursus?page[size]=100` で確認できる |
| `PISCINE_CURSUS_ID` | `9` | C Piscine。試験プロジェクトを探すのに使う |
| `SALE_START` | 空 | 「セール開始から」プリセットの既定値。例 `2026-08-25T18:00:00+09:00` |

`SALE_START` が空でも、画面で開始日時を入れて「開始をセール開始として保存」を押せば
ブラウザ（localStorage）に保存されます。

## 動作確認メモ

`curl` で 42 API を叩くときは **`-g`（`--globoff`）が必須**です。付けないと curl が
`page[size]` の角括弧を範囲指定として解釈し、`bad range in URL` で失敗します
（`-s` を付けていると何も表示されないので原因が分かりにくい）。

zsh の対話シェルは既定で `#` をコメントとして扱わないので、コメント付きの行をそのまま貼らないこと。

```bash
export FT_UID='u-s4t2ud-...'
read -s "FT_SECRET?Secret: " && export FT_SECRET

TOKEN=$(curl -s -X POST https://api.intra.42.fr/oauth/token \
  -d grant_type=client_credentials -d client_id="$FT_UID" -d client_secret="$FT_SECRET" \
  | jq -r .access_token)

curl -sS -g -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
  "https://api.intra.42.fr/v2/scale_teams?filter[campus_id]=26&range[filled_at]=2026-08-01T00:00:00.000Z,2026-08-30T00:00:00.000Z&page[size]=1"
```
