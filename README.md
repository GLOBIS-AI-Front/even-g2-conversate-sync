# Conversate Sync

Even G2 の会話を自前で文字起こしし、要約して Obsidian Vault に自動格納する。
公式 Conversate は文字起こしをスマホアプリ内にしか置かず、外に出す口が共有シートしか無い
（Even Hub SDK にも Conversate のデータを読む API は無い）。ゼロタッチにするには
自分でマイクから録るしかないので、その置き換えとして作ったもの。

```
G2(4マイク) ──PCM 16k──▶ プラグイン(iPhone WebView)
                              │ WebSocket
                              ▼
              Cloudflare Worker "conversate-relay"
              ├ Durable Object = 1 会話セッション
              ├ Soniox リアルタイム STT（話者分離あり）
              └ 確定 transcript を D1 に pending 保存
                              ▲ /pull  /ack
                              │
              Mac mini の poller（LaunchAgent 60 秒毎）
              └ 要約・アクション抽出・[[wikilink]] 生成
                 → Obsidian REST → wiki/sources/conversate-*.md
```

Worker に貯めてから Mac mini が引き取る形にしてあるので、会話中に Mac が寝ていても
取りこぼさない。Vault に書けたものだけ ack するので、書き込み失敗も次回再試行される。

> **自分の環境で動かすには** → [docs/SETUP.md](docs/SETUP.md)
> Cloudflare Worker の作り方から実機への配布まで、一から立ち上げる手順。
> リポジトリ内の Worker 名・D1 の ID・通信先は作者の環境の値なので、`npm run configure` で自分の値に差し替える。

## 構成

| パス | 中身 |
|---|---|
| `src/main.ts` | プラグイン本体（マイク取得・WS送信・レンズ表示・開始/停止） |
| `src/fake-audio.ts` | 開発用の擬似マイク。`?fakeAudio=1` のときだけ有効 |
| `src/config.ts` | 自動生成（Keychain から）。コミットしない |
| `app.json` | Even Hub マニフェスト。権限と通信先ホワイトリスト |
| `relay/src/index.ts` | Cloudflare Worker + Durable Object |
| `poller/conversate_sync.py` | Vault 格納の poller |
| `poller/com.miyoshi.conversate-sync.plist` | LaunchAgent 定義 |
| `scripts/configure.mjs` | Worker 名 / D1 / 通信先を自分の環境の値に一括置換 |
| `scripts/test-relay.mjs` | relay の疎通確認（実音声を流して保存まで見る） |
| `docs/SETUP.md` | 一から立ち上げる手順 |
| `docs/DEVELOPMENT.md` | 開発フローと踏んだ地雷の記録 |

## 操作（グラス側）

**起動した時点で記録が始まる。保存操作も要らない。** アプリを開けば録れていて、
そのまま閉じれば残る。開始も保存もユーザーに要求しない。

| 操作 | 動作 |
|---|---|
| 起動 | **記録開始**（タップ不要） |
| アプリを閉じる / 落とす | **そのまま保存**（明示的な停止は不要） |
| シングルタップ | 記録の停止 / 再開 |
| ダブルタップ | 終了ダイアログ |
| 5 分間まったく発話が拾えない | 自動停止して保存（切り忘れ対策） |

保存は relay 側で完結する。`stop` を送れれば綺麗に確定し、送る前に落とされても WS が
切れた時点で保存される。WS の切断すら飛んでこない場合に備えて、音声が 3 分途絶えたら
サーバ側で確定保存する保険も入れてある。

## クレデンシャル

値は Keychain にのみ置く。リポジトリにも Vault にも書かない。

| サービス名 | 用途 |
|---|---|
| `cred.even-conversate.plugin-token` | プラグイン → relay の認証 |
| `cred.even-conversate.pull-token` | poller → relay の認証 |
| `cred.event-insight.soniox-api-key` | Soniox（Worker secret として登録済み） |
| `cred.obsidian.obsidian-api-key` | Obsidian Local REST API |
| `cred.even-conversate.anthropic-api-key` | 任意。claude CLI が使えない場合の要約用 |

## 開発

```bash
npm run gen:config          # Keychain から src/config.ts を生成
npm run dev                 # Vite (localhost:5173)
npx evenhub-simulator "http://localhost:5173/?fakeAudio=1" --automation-port 9898
```

シミュレータ操作（実機なしの検証）:

```bash
curl -X POST http://127.0.0.1:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o shot.png
curl -s http://127.0.0.1:9898/api/console
```

## Worker

```bash
cd relay && npx wrangler deploy
npx wrangler tail                     # 実行ログ
npx wrangler d1 execute even-conversate --remote --command "SELECT id,status FROM conversations ORDER BY created_at DESC LIMIT 5"
```

## poller

```bash
python3 poller/conversate_sync.py --dry-run --once   # 書かずに中身を見る
cp poller/com.miyoshi.conversate-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.miyoshi.conversate-sync.plist
launchctl kickstart -k gui/$(id -u)/com.miyoshi.conversate-sync   # 再起動
tail -f ~/Library/Logs/conversate-sync.log
```

要約は 3 段構えで、どれも使えなくても書き起こしは必ず保存する。

1. `claude -p`（サブスク内で完結）
2. Anthropic API（`cred.even-conversate.anthropic-api-key` があれば）
3. 素のノート（`tags: [conversate, 要約未実施]` が付く）

## ハマりどころ

> 詳しい開発フローと実機配布の手順は [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) にある。

- **Workers の `fetch` は `wss://` を受け付けない**。`https://` に直して `Upgrade: websocket` を付ける
- **DO の WebSocket は既定でバイナリを `Blob` で渡す**。そのまま転送すると Soniox はテキスト扱いして弾く。
  本実装は確実性を優先して **base64 テキスト**で Soniox に送っている（経路は Worker→Soniox だけなので通信量は問題にならない）
- **Cloudflare は `Python-urllib` の User-Agent を 403 で弾く**。poller は UA を名乗る
- **シミュレータは `setInterval` を独自にキューイングする**。擬似マイクは自前タイマーではなく
  フラッシュタイマーから pull する方式にしてある
- **`app.json` の whitelist は CORS を免除しない**。Worker 側で CORS ヘッダを返す必要がある
- Android は WebView 停止時にマイクが止まる。iOS は生き続けるので長い会議でも切れない
