/**
 * Conversate Sync — Even G2 の会話を自前で文字起こしして Obsidian に流す。
 *
 *   G2 マイク --(PCM 16k)--> このプラグイン --(WS)--> conversate-relay --> Soniox
 *                                                          |
 *                                        Mac mini poller <--+  --> Obsidian
 *
 * 操作: シングルタップで 開始/停止、ダブルタップで終了ダイアログ。
 */
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  AudioInputSource,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { RELAY_HOST, PLUGIN_TOKEN, LANG_HINTS } from './config'

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'

/** WS へまとめて送る間隔。細かく送るほど遅延は減るが BLE/回線に負担がかかる。 */
const FLUSH_INTERVAL_MS = 200
/** 書き起こしが一定時間まったく増えなければ、切り忘れとみなして自動停止する。 */
const AUTO_STOP_MS = 5 * 60 * 1000
/** 通信断からの再接続を試みる回数。 */
const MAX_RECONNECT = 5

const LS_LAST_SAVED = 'conversate.lastSaved'

/** シミュレータ検証用の擬似マイク。URL に ?fakeAudio=1 が付いたときだけ有効。 */
const FAKE_AUDIO = new URLSearchParams(location.search).get('fakeAudio') === '1'
let fakeAudio: { next: (elapsedMs: number) => Uint8Array | null } | null = null
let lastFakePullAt = 0

type State = 'idle' | 'connecting' | 'recording' | 'saving' | 'error'

let bridge: EvenAppBridge
let state: State = 'idle'
let ws: WebSocket | null = null
let audioOn = false
let unsubscribeEvents: (() => void) | null = null

let pcmQueue: Uint8Array[] = []
let flushTimer: number | null = null
let startedAt = 0
let charCount = 0
let lastTextAt = 0
let tailText = ''
let statusNote = ''
let reconnects = 0
let lastSavedNote = ''

// ---------------------------------------------------------------- 表示

let lastRendered = ''
let renderBusy = false
let renderPending = false

function screen(): string {
  const head =
    state === 'recording'
      ? `● 録音中 ${clock(Date.now() - startedAt)}  ${charCount}字`
      : state === 'connecting'
        ? '… 接続中'
        : state === 'saving'
          ? '… 保存中'
          : state === 'error'
            ? `× ${statusNote}`
            : 'Conversate Sync'

  const body =
    state === 'recording'
      ? tailText || '（発話を待っています）'
      : state === 'idle'
        ? [
            'タップで会話の記録を開始',
            'もう一度タップで停止し保存',
            'ダブルタップで終了',
            lastSavedNote,
          ]
            .filter(Boolean)
            .join('\n')
        : statusNote

  return `${head}\n----------------\n${body}`
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * BLE 越しの更新は詰まりやすいので、直列化して同じ内容は送らない。
 * 送信中に来た更新は捨てずに覚えておき、終わり次第すぐ描き直す
 * （捨てると次のタイマーまで最大 200ms 遅れて表示がガタつく）。
 */
async function render() {
  if (renderBusy) {
    renderPending = true
    return
  }
  const next = screen()
  if (next === lastRendered) return
  renderBusy = true
  try {
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        contentOffset: 0,
        contentLength: 0,
        content: next.slice(0, 1800),
      }),
    )
    lastRendered = next
  } catch (e) {
    console.warn('render failed', e)
  } finally {
    renderBusy = false
    if (renderPending) {
      renderPending = false
      void render()
    }
  }
  mirrorToDom(next)
}

/** シミュレータ/ブラウザで中身を見るためのミラー。グラス表示には影響しない。 */
function mirrorToDom(text: string) {
  const el = document.getElementById('mirror')
  if (el) el.textContent = text
}

// ---------------------------------------------------------------- 録音

async function start() {
  if (state === 'recording' || state === 'connecting') return
  state = 'connecting'
  statusNote = '接続中…'
  charCount = 0
  tailText = ''
  reconnects = 0
  startedAt = Date.now()
  lastTextAt = Date.now()
  await render()

  const sessionId = `g2-${startedAt}`
  await openSocket(sessionId)
}

function openSocket(sessionId: string) {
  return new Promise<void>((resolve) => {
    const url =
      `wss://${RELAY_HOST}/ws?token=${encodeURIComponent(PLUGIN_TOKEN)}` +
      `&session=${encodeURIComponent(sessionId)}&lang=${encodeURIComponent(LANG_HINTS)}`
    const sock = new WebSocket(url)
    sock.binaryType = 'arraybuffer'
    ws = sock

    sock.onopen = async () => {
      if (!audioOn) {
        if (FAKE_AUDIO) {
          // シミュレータ検証用。実機では通らない経路。
          const { loadFakeAudio } = await import('./fake-audio')
          fakeAudio = await loadFakeAudio()
        } else {
          // グラス側マイク。createStartUpPageContainer 済みであることが前提。
          await bridge.audioControl(true, AudioInputSource.Glasses)
        }
        audioOn = true
      }
      state = 'recording'
      startFlushTimer()
      await render()
      resolve()
    }

    sock.onmessage = (event) => {
      let msg: any
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (msg.type === 'text') {
        charCount = msg.chars ?? charCount
        // relay が暫定込みの直近テキストを毎回まるごと送ってくるので置き換える
        // （追記すると暫定が確定に変わるたび二重に出る）
        tailText = msg.tail ?? tailText
        lastTextAt = Date.now()
      } else if (msg.type === 'saved') {
        lastSavedNote = `前回: ${msg.chars}字 保存済み`
        void bridge.setLocalStorage(LS_LAST_SAVED, String(Date.now()))
        state = 'idle'
        statusNote = ''
      } else if (msg.type === 'empty') {
        lastSavedNote = '前回: 発話なし'
        state = 'idle'
      } else if (msg.type === 'error') {
        statusNote = String(msg.message).slice(0, 60)
        state = 'error'
      }
      void render()
    }

    sock.onclose = () => {
      if (state === 'recording') {
        // 会話中に切れた: 同じ session に繋ぎ直す（続きは別セグメントとして保存される）
        void reconnect(sessionId)
      } else {
        void stopAudio()
      }
    }

    sock.onerror = () => {
      if (state === 'connecting') {
        state = 'error'
        statusNote = '接続に失敗しました'
        void render()
        resolve()
      }
    }
  })
}

async function reconnect(sessionId: string) {
  if (reconnects >= MAX_RECONNECT) {
    state = 'error'
    statusNote = '通信が切れました'
    await stopAudio()
    await render()
    return
  }
  reconnects++
  statusNote = `再接続中 (${reconnects})`
  await render()
  await new Promise((r) => setTimeout(r, 1000 * reconnects))
  if (state === 'recording' || state === 'error') await openSocket(`${sessionId}-r${reconnects}`)
}

function startFlushTimer() {
  if (flushTimer !== null) return
  lastFakePullAt = Date.now()
  flushTimer = window.setInterval(() => {
    if (fakeAudio) {
      const now = Date.now()
      const chunk = fakeAudio.next(now - lastFakePullAt)
      lastFakePullAt = now
      if (chunk) pcmQueue.push(chunk)
    }
    flushAudio()

    if (state === 'recording') {
      if (Date.now() - lastTextAt > AUTO_STOP_MS) {
        statusNote = '無音が続いたため自動停止'
        void stop()
        return
      }
      void render() // 経過時間の更新
    }
  }, FLUSH_INTERVAL_MS)
}

function flushAudio() {
  if (!pcmQueue.length) return
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // 送れない間は溜めておく（上限つき: 16kHz s16le で約60秒）
    if (pcmQueue.length > 300) pcmQueue = pcmQueue.slice(-300)
    return
  }
  const total = pcmQueue.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of pcmQueue) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  pcmQueue = []
  ws.send(merged)
}

async function stop() {
  if (state !== 'recording' && state !== 'error') return
  state = 'saving'
  await render()

  flushAudio()
  await stopAudio()

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }))
    // saved / empty が返れば onmessage 側で idle に戻る
  } else {
    state = 'idle'
    await render()
  }
}

async function stopAudio() {
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  if (audioOn) {
    if (fakeAudio) {
      fakeAudio = null
    } else {
      try {
        await bridge.audioControl(false)
      } catch (e) {
        console.warn('audioControl(false) failed', e)
      }
    }
    audioOn = false
  }
}

async function cleanup() {
  await stopAudio()
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  unsubscribeEvents?.()
}

// ---------------------------------------------------------------- 起動

async function main() {
  bridge = await waitForEvenAppBridge()

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          borderWidth: 0,
          borderColor: 5,
          paddingLength: 4,
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content: 'Conversate Sync\n----------------\nタップで会話の記録を開始',
          isEventCapture: 1,
        }),
      ],
    }),
  )
  if (result !== 0) console.error('startup page failed:', result)

  unsubscribeEvents = bridge.onEvenHubEvent((event: any) => {
    // 音声フレーム
    const audio = event.audioEvent
    if (audio?.audioPcm) {
      if (state === 'recording' || state === 'connecting') {
        pcmQueue.push(new Uint8Array(audio.audioPcm))
      }
      return
    }

    const sys = event.sysEvent
    if (!sys) return
    const type = sys.eventType ?? 0

    if (type === 0) {
      // シングルタップ = 開始/停止
      if (state === 'recording') void stop()
      else if (state === 'idle' || state === 'error') void start()
      return
    }
    if (type === 3) {
      // ダブルタップ = 終了確認ダイアログ（ここでは後片付けしない）
      void bridge.shutDownPageContainer(1)
      return
    }
    if (type === 5) {
      // バックグラウンドへ。iOS は WebView が生き続けるので録音は続行する。
      return
    }
    if (type === 6 || type === 7) {
      void cleanup()
    }
  })

  lastSavedNote = (await bridge.getLocalStorage(LS_LAST_SAVED))
    ? `前回保存: ${new Date(Number(await bridge.getLocalStorage(LS_LAST_SAVED))).toLocaleString('ja-JP')}`
    : ''

  window.addEventListener('beforeunload', () => void cleanup())

  await render()
}

void main()
