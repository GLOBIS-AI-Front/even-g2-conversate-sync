#!/usr/bin/env python3
"""conversate-sync

conversate-relay に溜まった会話の書き起こしを引き取り、要約して Obsidian Vault に
1 会話 = 1 ノートとして格納し、relay に ack する。LaunchAgent から 60 秒ごとに叩く。

要約は 3 段構え。どれも使えなくても書き起こしは必ず保存する（取りこぼさないことが最優先）。
  1. claude CLI (`claude -p`) — サブスク内で完結。使えるならこれ。
  2. Anthropic API — Keychain に cred.even-conversate.anthropic-api-key があれば。
  3. 素のノート — 書き起こしだけのノートを保存し、要約は後追いできるよう印を付ける。

Vault への書き込みは Obsidian Local REST API 経由（実体は Mac mini にしか無い）。
ack するのは Vault に書けたものだけ。書けなければ relay に残り、次回再試行される。

  --dry-run  Vault に書かず標準出力に出す（ack もしない）
  --once     1 件だけ処理する
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

RELAY_HOST = os.environ.get("RELAY_HOST", "conversate-relay.miyoshi-bd1.workers.dev")
OBSIDIAN_HOST = os.environ.get("OBSIDIAN_HOST", "100.113.58.43")
OBSIDIAN_PORT = os.environ.get("OBSIDIAN_PORT", "27124")
VAULT_DIR = os.environ.get("VAULT_DIR", "wiki/sources")
LOG_PATH = Path(
    os.environ.get("CONVERSATE_LOG", Path.home() / "Library/Logs/conversate-sync.log")
)
LOCK_PATH = Path("/tmp/conversate-sync.lock")
SUMMARY_MODEL = os.environ.get("CONVERSATE_MODEL", "claude-sonnet-5")


def log(msg: str) -> None:
    line = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, file=sys.stderr)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def keychain(service: str) -> str | None:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() or None


# ---------------------------------------------------------------- relay


# Cloudflare は既定の Python-urllib という UA を 403 で弾くので必ず名乗る
USER_AGENT = "conversate-sync/1.0"


def relay_pull(token: str, limit: int = 5) -> list[dict]:
    req = urllib.request.Request(
        f"https://{RELAY_HOST}/pull?limit={limit}",
        headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp).get("conversations", [])


def relay_ack(token: str, ids: list[str]) -> None:
    body = json.dumps({"ids": ids}).encode()
    req = urllib.request.Request(
        f"https://{RELAY_HOST}/ack",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20):
        pass


# ---------------------------------------------------------------- Obsidian


def _obsidian_ctx():
    import ssl

    ctx = ssl.create_default_context()
    # Local REST API は自己署名証明書。宛先は自分の tailnet 内のホストに限定される。
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def obsidian_up() -> bool:
    try:
        urllib.request.urlopen(
            f"https://{OBSIDIAN_HOST}:{OBSIDIAN_PORT}/", timeout=4, context=_obsidian_ctx()
        )
        return True
    except urllib.error.HTTPError:
        return True  # 認証エラーでもサーバは生きている
    except Exception:
        return False


def obsidian_put(path: str, markdown: str, key: str) -> bool:
    req = urllib.request.Request(
        f"https://{OBSIDIAN_HOST}:{OBSIDIAN_PORT}/vault/{path}",
        data=markdown.encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "text/markdown"},
        method="PUT",
    )
    try:
        urllib.request.urlopen(req, timeout=20, context=_obsidian_ctx())
        return True
    except Exception as e:  # noqa: BLE001
        log(f"Vault 書き込み失敗 {path}: {e}")
        return False


# ---------------------------------------------------------------- 要約

PROMPT_TEMPLATE = """以下は Even G2 スマートグラスで記録した会話の書き起こしです。話者分離は自動なので誤りを含みます。
これを Obsidian のノート本文（Markdown）に整えてください。出力はノート本文のみ。前置きやコードフェンスは付けないこと。

書式:
---
title: <会話の内容がひと目で分かる簡潔な日本語タイトル>
date: {date}
source: even-g2-conversate
duration_min: {minutes}
tags: [conversate, <内容に応じたタグを2〜4個>]
---

# <タイトル>

> {started} から {minutes} 分

## 要約
<3〜5行。何の話で、何が決まったか>

## 決定事項
<箇条書き。無ければ「なし」>

## アクションアイテム
<- [ ] 形式。誰が何をいつまでに。担当が不明なら書かない。無ければ「なし」>

## 論点・未決
<箇条書き。無ければ節ごと省略>

## 関連
<会話に出た人物・組織・技術・プロジェクトを [[wikilink]] 形式で列挙。一般名詞はリンクにしない>

## 書き起こし
<書き起こしを、明らかな誤変換だけ直してそのまま載せる。発言は消さない>

--- 書き起こしここから ---
{transcript}
"""


def summarize_with_claude_cli(prompt: str) -> str | None:
    try:
        out = subprocess.run(
            ["claude", "-p", prompt, "--setting-sources", ""],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as e:
        log(f"claude CLI 実行不可: {e}")
        return None
    if out.returncode != 0 or not out.stdout.strip():
        log(f"claude CLI 失敗 (rc={out.returncode}): {out.stdout.strip()[:120]}")
        return None
    return out.stdout.strip()


def summarize_with_api(prompt: str, api_key: str) -> str | None:
    body = json.dumps(
        {
            "model": SUMMARY_MODEL,
            "max_tokens": 8000,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.load(resp)
        return "".join(b.get("text", "") for b in data.get("content", [])).strip() or None
    except Exception as e:  # noqa: BLE001
        log(f"Anthropic API 失敗: {e}")
        return None


def plain_note(meta: dict, transcript: str) -> str:
    """要約できなかったときでも書き起こしは必ず残す。"""
    return f"""---
title: 会話メモ {meta["started"]}
date: {meta["date"]}
source: even-g2-conversate
duration_min: {meta["minutes"]}
tags: [conversate, 要約未実施]
---

# 会話メモ {meta["started"]}

> {meta["started"]} から {meta["minutes"]} 分
> 要約の生成に失敗したため書き起こしのみ保存しています。

## 書き起こし

{transcript}
"""


def build_note(meta: dict, transcript: str) -> tuple[str, str]:
    """(ノート本文, 生成手段) を返す。"""
    prompt = PROMPT_TEMPLATE.format(transcript=transcript, **meta)

    note = summarize_with_claude_cli(prompt)
    if note:
        return note, "claude-cli"

    api_key = keychain("cred.even-conversate.anthropic-api-key")
    if api_key:
        note = summarize_with_api(prompt, api_key)
        if note:
            return note, f"api:{SUMMARY_MODEL}"

    return plain_note(meta, transcript), "fallback"


# ---------------------------------------------------------------- main


def meta_from(conv: dict) -> dict:
    started = dt.datetime.fromtimestamp(conv["started_at"] / 1000)
    return {
        "slug": f"conversate-{started:%Y-%m-%d-%H%M}",
        "started": f"{started:%Y-%m-%d %H:%M}",
        "date": f"{started:%Y-%m-%d}",
        "minutes": round(conv["duration_ms"] / 60000, 1),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    # 多重起動を防ぐ（要約中に次の tick が来る）
    try:
        LOCK_PATH.mkdir()
    except FileExistsError:
        return 0
    try:
        return run(args)
    finally:
        try:
            LOCK_PATH.rmdir()
        except OSError:
            pass


def run(args) -> int:
    pull_token = keychain("cred.even-conversate.pull-token")
    if not pull_token:
        log("pull token が Keychain にありません")
        return 1

    try:
        conversations = relay_pull(pull_token)
    except Exception as e:  # noqa: BLE001
        log(f"relay に到達できません: {e}")
        return 0

    if not conversations:
        return 0
    log(f"{len(conversations)} 件の会話を取得")

    obsidian_key = None
    if not args.dry_run:
        if not obsidian_up():
            log("Obsidian に到達できないので見送り（relay 側に残す）")
            return 0
        obsidian_key = keychain("cred.obsidian.obsidian-api-key")
        if not obsidian_key:
            log("Obsidian API キーが Keychain にありません")
            return 1

    acked: list[str] = []
    for conv in conversations:
        meta = meta_from(conv)
        log(f"処理中: {conv['id']} ({meta['minutes']}分)")

        note, how = build_note(meta, conv["transcript"])
        path = f"{VAULT_DIR}/{meta['slug']}.md"

        if args.dry_run:
            print(f"=== {path}  (要約: {how}) ===")
            print(note)
        else:
            if not obsidian_put(path, note, obsidian_key):
                continue  # 次の tick で再試行
            log(f"保存: {path} (要約: {how})")
            acked.append(conv["id"])

        if args.once:
            break

    if acked:
        try:
            relay_ack(pull_token, acked)
            log(f"ack: {len(acked)} 件")
        except Exception as e:  # noqa: BLE001
            log(f"ack 失敗（次回重複する可能性あり）: {e}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
