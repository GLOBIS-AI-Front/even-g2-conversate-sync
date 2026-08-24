/**
 * relay の疎通確認。PCM(16kHz mono s16le) を実時間で流し込み、
 * 文字起こしが返って保存されるところまでを確かめる。
 *
 *   node scripts/test-relay.mjs /tmp/sample.pcm
 *
 * 宛先は app.json のホワイトリストから、トークンは Keychain から読む。
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const file = process.argv[2]
if (!file) {
  console.error('使い方: node scripts/test-relay.mjs <PCMファイル>')
  process.exit(1)
}

const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'))
const wss = app.permissions
  .find((p) => p.name === 'network')
  ?.whitelist.find((u) => u.startsWith('wss://'))
if (!wss) {
  console.error('app.json のホワイトリストに wss:// のエントリがありません')
  process.exit(1)
}

const token = execFileSync(
  'security',
  ['find-generic-password', '-s', 'cred.even-conversate.plugin-token', '-w'],
  { encoding: 'utf8' },
).trim()

const pcm = readFileSync(file)
const seconds = (pcm.length / 32000).toFixed(1)
console.log(`${wss} へ ${seconds} 秒ぶんを送ります`)

const ws = new WebSocket(
  `${wss}/ws?token=${encodeURIComponent(token)}&session=test-${Date.now()}&lang=ja,en`,
)
ws.binaryType = 'arraybuffer'

const CHUNK = 3200 // 100ms
let saved = false
let t0 = 0

ws.onopen = async () => {
  t0 = Date.now()
  for (let i = 0; i < pcm.length; i += CHUNK) {
    ws.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)))
    await new Promise((r) => setTimeout(r, 100)) // 実機と同じ速さで流す
  }
  ws.send(JSON.stringify({ type: 'stop' }))
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.type === 'text') {
    process.stdout.write(`\r[${Date.now() - t0}ms] ${String(m.tail ?? '').slice(-40)}   `)
  } else {
    console.log(`\n[${m.type}] ${JSON.stringify(m)}`)
  }
  if (m.type === 'saved' || m.type === 'empty') saved = true
}

ws.onerror = (e) => console.error('\n接続エラー:', e.message ?? e)
ws.onclose = () => {
  console.log(saved ? '\nOK: relay は正常です' : '\nNG: 保存まで到達しませんでした')
  process.exit(saved ? 0 : 1)
}

setTimeout(() => {
  console.error('\nタイムアウト')
  process.exit(1)
}, 120_000)
