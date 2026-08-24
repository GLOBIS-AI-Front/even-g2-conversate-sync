# セットアップ手順

自分の環境で Conversate Sync を一から立ち上げる手順。所要 1〜2 時間。

リポジトリに入っている値（Worker 名・D1 の ID・Keychain のサービス名）は**作者の環境のもの**なので、
手順 2 で自分の値に置き換える。置き換えは `npm run configure` が一括でやる。

---

## 全体像

3 つの部品を、この順で立ち上げる。**前の部品が動いてから次に進む**のが結局早い。

```
1. relay   … Cloudflare Worker。音声を受けて Soniox に流し、文字起こしを貯める
2. plugin  … Even Hub アプリ。G2 のマイクを relay に流し、レンズに字幕を出す
3. poller  … Mac 常駐。relay から引き取り、要約して Obsidian に書く
```

---

## 0. 用意するもの

| 要るもの | 用途 | 備考 |
|---|---|---|
| Even G2 | — | R1 リングは無くてよい |
| iPhone | プラグインの実行環境 | Android は WebView 停止時にマイクが止まるため非推奨 |
| Cloudflare アカウント | relay | 無料枠で足りる |
| Soniox の API キー | 文字起こし | https://soniox.com で取得。従量課金 |
| Even Hub 開発者アカウント | 実機配布 | https://hub.evenrealities.com。**スマホアプリと同じアカウント**で作る |
| Obsidian + Local REST API プラグイン | 保存先 | Vault のあるマシンで有効化しておく |
| Node.js 20+ / macOS | ビルドと poller | poller は launchd 前提 |

要約に `claude` CLI を使う。無くても動く（書き起こしのみ保存される）。

---

## 1. 取得と依存の導入

```bash
git clone <このリポジトリ> even-conversate && cd even-conversate
npm install --legacy-peer-deps      # evenhub-cli が typescript ^5 を要求するため
npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
cd relay && npm install && cd ..
```

---

## 2. クレデンシャルを Keychain に入れる

値はリポジトリにも Vault にも書かない。macOS Keychain に置く。

```bash
# relay とプラグインの間の合言葉（自動生成でよい）
security add-generic-password -a "$USER" -s "cred.even-conversate.plugin-token" -A -U -w "$(openssl rand -hex 32)"
# relay と poller の間の合言葉
security add-generic-password -a "$USER" -s "cred.even-conversate.pull-token"   -A -U -w "$(openssl rand -hex 32)"
```

Soniox のキーと Obsidian の API キーは、値を対話で入れる（履歴に残さない）。

```bash
security add-generic-password -a "$USER" -s "cred.even-conversate.soniox-api-key" -A -U -w
security add-generic-password -a "$USER" -s "cred.obsidian.obsidian-api-key"      -A -U -w
```

---

## 3. relay を立てる（Cloudflare Worker）

### 3-1. D1 データベースを作る

```bash
cd relay
npx wrangler login
npx wrangler d1 create even-conversate
```

出力される `database_id` を控える。

### 3-2. 自分の値に差し替える

```bash
cd ..
npm run configure -- --worker <Worker名> --subdomain <あなたのworkers.devサブドメイン> --d1 <database_id>
```

`relay/wrangler.jsonc` の Worker 名と D1 ID、`app.json` の通信先ホワイトリストが書き換わる。
サブドメインは `npx wrangler whoami` か Cloudflare ダッシュボードで確認できる。

### 3-3. スキーマとシークレット

```bash
cd relay
npx wrangler d1 execute <Worker名と同じDB名> --remote --file ./schema.sql

security find-generic-password -s "cred.even-conversate.soniox-api-key" -w | npx wrangler secret put SONIOX_API_KEY
security find-generic-password -s "cred.even-conversate.plugin-token"   -w | npx wrangler secret put PLUGIN_TOKEN
security find-generic-password -s "cred.even-conversate.pull-token"     -w | npx wrangler secret put PULL_TOKEN
```

`|` で渡すのは、値をコマンド引数に置くとシェル履歴とプロセス一覧に残るため。

### 3-4. デプロイと疎通確認

```bash
npx wrangler deploy
curl -s https://<Worker名>.<サブドメイン>.workers.dev/health     # → {"ok":true}
```

### 3-5. 実音声で通す（実機の前に必ずやる）

合成音声を作って WebSocket に流し込み、**文字起こしが返って D1 に保存される**ところまで確認する。
ここが通っていれば、後で実機が動かないときに relay を疑わなくて済む。

```bash
say -v Kyoko -o /tmp/a.aiff "テストです。文字起こしが返るか確認しています。"
ffmpeg -y -i /tmp/a.aiff -ar 16000 -ac 1 -f s16le /tmp/sample.pcm
node scripts/test-relay.mjs /tmp/sample.pcm
```

`{"type":"saved", ...}` が出れば relay は完成。

---

## 4. プラグインを実機に入れる

### 4-1. 設定ファイルの生成とビルド

```bash
npm run gen:config          # Keychain から src/config.ts を作る（コミットされない）
npm run build
rm -rf dist/dev             # 検証用の擬似音声を製品版から除く
npx evenhub pack app.json dist    # → out.ehpk
```

`app.json` の `package_id` は**自分のもの**に変えること（`com.example.myconversate` 等）。

### 4-2. Even Hub に上げる

1. https://hub.evenrealities.com にログイン（**スマホアプリと同じアカウント**）
2. `Upload package` で `out.ehpk` を上げる
3. プロジェクトを開く → **Builds タブ** → ビルド行をクリック
4. **`Private` バッジがドロップダウン**。ここで **Beta** を選ぶ
5. 確認ダイアログの **`Promote to Beta`** を押す
6. **Testing group タブ** → `Add user` → 自分のメールアドレス
7. 届いた招待メールを**スマホで開き**、`Open in Even Realities App` からインストール

**手順 4-5 を飛ばすと何も起きない。** Private のままだと配布されず、アプリ側のどこにも現れない。
Private ビルドは有効期限で切れ、ロック中に録音が止まり、グラスのメニューにも載らないので、
実運用では必ず Beta にする。詳しくは [DEVELOPMENT.md](DEVELOPMENT.md#7-実機への配布--ここが一番ハマった)。

### 4-3. 実機なしで確かめたい場合

```bash
npm run dev
npx evenhub-simulator "http://localhost:5173/?fakeAudio=1" --automation-port 9898
curl -s http://127.0.0.1:9898/api/screenshot/glasses -o shot.png
```

---

## 5. poller を常駐させる（Vault のあるマシン）

```bash
python3 poller/conversate_sync.py --dry-run --once   # 書かずに中身を確認
```

`(要約: claude-cli)` なら要約つき、`(要約: fallback)` なら書き起こしのみ保存される。

問題なければ常駐させる。**plist 内のパスとユーザー名を自分のものに書き換えてから**置く。

```bash
sed -e "s|/Users/miyoshi|$HOME|g" poller/com.miyoshi.conversate-sync.plist \
  > ~/Library/LaunchAgents/com.miyoshi.conversate-sync.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.miyoshi.conversate-sync.plist
tail -f ~/Library/Logs/conversate-sync.err.log
```

環境変数で挙動を変えられる。

| 変数 | 既定 | 意味 |
|---|---|---|
| `RELAY_HOST` | 作者の Worker | relay のホスト名 |
| `OBSIDIAN_HOST` | `100.113.58.43` | Obsidian REST の宛先。**同じマシンなら `127.0.0.1`** |
| `VAULT_DIR` | `wiki/sources` | ノートの保存先 |
| `CONVERSATE_MODEL` | `claude-sonnet-5` | API 経由で要約する場合のモデル |

---

## 6. 通し確認

1. iPhone でプラグインを起動する（**起動した時点で録音が始まる**）
2. 何か話す。レンズに字幕が流れる
3. アプリを閉じる（**保存操作は要らない**）
4. 60 秒以内に `wiki/sources/conversate-YYYY-MM-DD-HHMM.md` が生える

途中で止まったら、どこまで進んだかで切り分ける。

```bash
curl -s "https://<Worker>/pull" -H "Authorization: Bearer $(security find-generic-password -s cred.even-conversate.pull-token -w)" -H "User-Agent: check/1.0"
tail -20 ~/Library/Logs/conversate-sync.err.log
cd relay && npx wrangler tail
```

- `/pull` に会話が出る → relay まで OK。poller 側の問題
- `/pull` が空 → プラグインか relay の問題。`wrangler tail` を見る

---

## 費用

| | |
|---|---|
| Cloudflare Workers / D1 | 無料枠で足りる（個人利用の範囲） |
| Soniox | 従量課金。音声時間に比例する |
| 要約 | `claude` CLI ならサブスク内。API キー利用なら従量課金 |

---

## 注意

**会話の音声は Soniox に送信される。** 端末内で完結する処理ではない。
機微な会話を扱う場合は、この点を承知して使うこと（公式 Conversate も外部の委託先に音声を送っている）。
