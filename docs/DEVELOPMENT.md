# 開発フロー

Conversate Sync をゼロから作って実機で動かすまでの記録。
同じことをもう一度やる人（未来の自分）が、踏んだ地雷を踏まずに辿れるように書く。

---

## 0. なぜ自作したのか

「公式 Conversate の結果を自動で PC に同期したい」が出発点だったが、**それは原理的に不可能**だと調査で判明した。

- 文字起こし・要約は**スマホアプリ内にのみ保存**（音声は保存されない）
- 外に出す手段は**共有シートからの PDF / テキストのみ**。クラウド同期も API も無い
- [Even Hub SDK](https://hub.evenrealities.com/docs) の Device APIs にも **Conversate のデータを読む API は存在しない**
  （触れるのはタッチ / IMU / 位置 / マイク / カメラ / localStorage まで）

一方で **マイク入力 API は開放されている**（`audioControl()`、4 マイクアレイ、PCM 16kHz mono）。
よってゼロタッチにするには「公式 Conversate の同期」ではなく「**Conversate 相当を自作して置き換える**」しかない。これが本プロジェクトの前提。

その代わり、要約プロンプトと保存先を完全に自分で決められる。

---

## 1. 全体像

```
G2(4マイク) ──PCM 16k──▶ プラグイン(iPhone WebView)
                              │ WebSocket
                              ▼
              Cloudflare Worker "conversate-relay"
              ├ Durable Object = 1 会話セッション
              ├ Soniox stt-rt-v5（話者分離つきリアルタイム STT）
              └ 確定 transcript を D1 に pending 保存
                              ▲ /pull  /ack （Bearer 認証）
                              │
              Mac mini の poller（LaunchAgent 60 秒毎）
              ├ claude -p で要約・アクション抽出・[[wikilink]] 生成
              └ Obsidian REST → wiki/sources/conversate-*.md
```

**Worker に貯めてから Mac mini が引き取る**のが設計の要。会話中に Mac が寝ていても、
起きたときに取りに行くので取りこぼさない。Vault に書けたものだけ ack するので、
書き込み失敗も次の tick で再試行される。

---

## 2. 作った順番

実機が無い状態でも進められる順に並べたのが結果的に正解だった。
**一番の未知数（音声中継）を最初に潰す**と、後段の手戻りが無くなる。

| 順 | やったこと | 実機の要否 |
|---|---|---|
| 1 | SDK 調査（マイク API とネットワーク制約の確認） | 不要 |
| 2 | **Worker + Soniox 中継を先に完成**させ、合成音声で E2E | 不要 |
| 3 | プラグイン実装（マイク→WS、レンズ表示、開始/停止） | 不要 |
| 4 | シミュレータ + 擬似マイクで通し検証 | 不要 |
| 5 | poller 実装 → Mac mini で常駐化 | 不要 |
| 6 | 実機配布（Private → **Beta**） | 必要 |

検証用の音声は `say` で作れる。話者分離を試すなら 2 声を繋ぐ。

```bash
say -v Eddy -o a.aiff "来週の勉強会だけど、資料はどこまでできてる？"
say -v Flo  -o b.aiff "評価の章まで書けました。会場は渋谷で20名分押さえました。"
for f in a b; do ffmpeg -y -i $f.aiff -ar 16000 -ac 1 -f s16le $f.pcm; done
cat a.pcm b.pcm > sample.pcm
```

---

## 3. 環境構築

```bash
npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
npm install --legacy-peer-deps        # evenhub-cli が typescript ^5 を要求するため
npm run gen:config                    # Keychain から src/config.ts を生成
```

Even Realities は Claude Code 用の公式スキル集を出している。SDK の細部はこれが一番早い。

```bash
git clone --depth 1 https://github.com/even-realities/everything-evenhub.git
# plugins/everything-evenhub/skills/ 配下に 13 個の SKILL.md
```

---

## 4. ローカル開発とシミュレータ検証

```bash
npm run dev                                   # vite --host（LAN 公開が必須）
npx evenhub-simulator "http://localhost:5173/?fakeAudio=1" --automation-port 9898
```

シミュレータは HTTP で自動操作できるので、実機なしで通し検証ができる。

```bash
curl -X POST http://127.0.0.1:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o shot.png   # 576x288 RGBA
curl -s http://127.0.0.1:9898/api/console
```

スクリーンショットは RGBA で、点灯画素は `alpha > 0` で判定する（RGB に変換すると背景と区別できなくなる）。

---

## 5. Worker

```bash
cd relay
npx wrangler deploy
npx wrangler tail
npx wrangler d1 execute even-conversate --remote --command "SELECT id,status FROM conversations ORDER BY created_at DESC LIMIT 5"
```

シークレットは Keychain から直接流し込む（値を履歴に残さない）。

```bash
security find-generic-password -s "cred.even-conversate.pull-token" -w | npx wrangler secret put PULL_TOKEN
```

---

## 6. poller（Mac mini）

```bash
python3 poller/conversate_sync.py --dry-run --once      # 書かずに中身を見る
cp poller/com.miyoshi.conversate-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.miyoshi.conversate-sync.plist
tail -f ~/Library/Logs/conversate-sync.err.log
```

要約は 3 段構えで、**どれも使えなくても書き起こしは必ず保存する**。

1. `claude -p`（サブスク内で完結。Mac mini では LaunchAgent 配下でも通る）
2. Anthropic API（`cred.even-conversate.anthropic-api-key` があれば）
3. 素のノート（`tags: [conversate, 要約未実施]` が付くので後から追いかけられる）

---

## 7. 実機への配布 ← ここが一番ハマった

配布モードは **Public / Beta / Private** の 3 つ。用途がまるで違う。

| | Private | **Beta** | Public |
|---|---|---|---|
| 用途 | 開発中の使い捨て | **実運用できるテスト配布** | 公開ストア（審査あり） |
| OS ライフサイクル | シミュレーション | **リリース版と完全に同一** | 同左 |
| ロック中の維持 | ごく短時間 | 5 分 | 同左 |
| 有効期限 | **切れる**（実測で数十分） | 実用上問題なし | — |
| グラスのメニュー | 載らない | **載る** | 載る |

**長い会話を録る用途では Private は使えない。** iPhone をロックしただけで録音が切れるうえ、
しばらくすると「テスト版の有効期限が切れました」になる。最初から Beta にすること。

### 手順

```bash
npm run build
rm -rf dist/dev                    # 検証用の擬似マイク音声を製品版から除く
npx evenhub pack app.json dist     # → out.ehpk
```

1. [hub.evenrealities.com](https://hub.evenrealities.com/hub) にログイン（**スマホアプリと同じアカウント**）
2. `Upload package` で `out.ehpk` をアップロード
3. プロジェクトを開く → **Builds タブ** → ビルド行をクリック
4. **`Private` バッジがドロップダウンになっている**。ここで **Beta** を選ぶ
5. 確認ダイアログで **`Promote to Beta`** を押して確定する
6. **Testing group タブ** → `Add user` → 自分のメールアドレスを追加
7. 届いた招待メールを**スマホで開き**、`Open in Even Realities App` からインストール

### 更新版の出し方

2 回目以降も同じ流れだが、**バージョンを上げないとアップロードできない**。

```bash
# app.json の version を上げる
npm run build && rm -rf dist/dev && npx evenhub pack app.json dist
```

ポータルで `Upload a build` → Change log を書いて `Add build` → **新しいビルドを Beta に昇格**。
昇格すると前のバージョンは自動的に Private に降格する。スマホ側は再インストールが要る。

### 踏んだ地雷

- **手順 4-5 を飛ばすと詰む。** Testing group にユーザーを追加しただけでは配布物が Private のままで、
  アプリ側には何も現れない。確認ダイアログの `Beta group` 行を押すとユーザー管理タブに飛んでしまい、
  **モードが保存されないまま**になるので、必ず `Promote to Beta` を直接押す
- **インストールの入口は招待メールのリンク**。アプリ内をいくら探しても見つからない
- Even Hub タブ右上の開発者セクション（`Scan QR`）は、Web ハブへのログイン＋アプリの完全終了で出る
  ことになっているが、**出ないことがある**。出なくても Beta 配布で実機に入るので深追いしなくてよい

---

## 8. ハマりどころ（全て実測で確認）

### Cloudflare / Worker

- **`fetch` は `wss://` スキームを受け付けない。** `https://` に直して `Upgrade: websocket` を付ける
- **Durable Object の WebSocket は既定でバイナリを `Blob` で渡す。** そのまま Soniox に転送すると
  「テキスト扱い」で弾かれる。本実装は確実性を優先して **base64 テキスト**で送っている
  （経路は Worker→Soniox だけなので 33% の増分はスマホの通信量に影響しない）
- **既定の `Python-urllib` という User-Agent は 403 で弾かれる。** poller は UA を名乗る

### 文字起こしの体感遅延（v0.1.1 で修正）

**確定トークン（`is_final`）だけをレンズに送ると、字幕として実用にならない。**
Soniox は暫定トークンをほぼ即座に返すが、確定は文脈と無音を待ってから出すので、
その待ち時間がまるごと体感遅延になる。実機で「遅くて実用に耐えない」と判明した。

修正は、**表示は暫定込みで即出しし、保存する transcript には確定だけを積む**（字幕表示の定石）。

- 暫定トークンは毎回まるごと送り直されるので、**追記ではなく置き換える**
- relay は差分ではなく「直近テキストの絶対値」を送る。差分だと暫定→確定の切り替わりで二重に出る
- BLE 送信中に来た更新を捨てると次のタイマーまで遅れるので、`renderPending` で覚えて描き直す

実測（合成音声）: **発話開始から 916ms で初回表示**、以降は音声に追随して流れる。

**relay のメッセージ形式を変えるときは旧プラグインを壊さないこと。** Worker は即座に全員へ効くが、
プラグインはスマホ側で再インストールされるまで古いままなので、両者が食い違う時間が必ずある。
`text` を `tail` に置き換えたときは、旧プラグインが `undefined` を延々と連結してレンズを埋め尽くした。
**新旧どちらのフィールドも送る**のが正解（旧が追記する `text` には確定ぶんの差分を入れておけば無害）。

### Even Hub

- `app.json` の network whitelist は **CORS を免除しない**。Worker 側で CORS ヘッダを返す必要がある
- シミュレータは `setInterval` を独自にキューイングする。擬似マイクを自前タイマーで回すと発火しないので、
  フラッシュタイマーから **pull する方式**にしてある
- Android は WebView 停止時にマイクが止まる。**iOS は生き続ける**ので長い会議でも切れない

### Mac mini 固有

- python.org 版 Python は **CA バンドルを持たない**（`CERTIFICATE_VERIFY_FAILED`）。certifi を明示的に信頼元にする
- Command Line Tools 未導入で `/usr/bin/python3` が動かない。LaunchAgent は `/usr/local/bin/python3` を指す
- `node_modules` を **arm64 の MacBook から持ち込むと動かない**（`@rolldown/binding-darwin-x64` が無い）。
  入れ直しが必要
- `claude -p` のヘッドレス実行は **Mac mini では通る**（MacBook 側は OAuth 期限切れで落ちた）。
  LaunchAgent 配下でも Keychain 参照・claude 実行とも成功する

---

## 9. 運用の確認コマンド

```bash
curl -s https://conversate-relay.miyoshi-bd1.workers.dev/health      # Worker 生存確認
tail -f ~/Library/Logs/conversate-sync.err.log                       # poller の動き
launchctl print gui/$(id -u)/com.miyoshi.conversate-sync | grep -E "state|runs|last exit"
ls -lt ~/ObsidianValut/wiki/sources/conversate-*.md | head           # 生成されたノート
```

会話を止めてから Vault にノートが生えるまでの実測は **11〜21 秒**（poller の tick 待ちを除く）。

---

## 10. まだ確かめていないこと

- **公式 Conversate とマイクを取り合うか。** SDK ドキュメントに併用可否の記載がない。
  排他なら「Conversate Sync を使う間は公式を起動しない」運用になる
- ~~長時間の会話で途切れないか~~ → **実機で途切れないことを確認済み**（keepalive が効いている）
- **公式 Conversate が何の ASR を使っているかは非公開。** 製品ページ・サポートセンター・アプリストアの
  いずれにもベンダー名の記載がない
- `onLaunchSource` で `glassesMenu` 起動を判定し、グラスから起動したときだけ自動で録音を開始する案（保留中）
