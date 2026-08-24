/**
 * conversate-relay
 *
 * Even G2 のプラグインから届く PCM 音声を Soniox のリアルタイム STT に中継し、
 * 会話が終わったら確定 transcript を D1 に貯める。
 * Mac mini 側の poller が /pull で引き取り、要約して Obsidian に格納する。
 *
 *   plugin --(WS: PCM)--> [Session DO] --(WS)--> Soniox
 *                              |
 *                              +--> D1 conversations (status=pending)
 *                                        ^
 *                          Mac mini poller --(/pull, /ack)--+
 */

export interface Env {
  DB: D1Database
  SESSION: DurableObjectNamespace
  SONIOX_MODEL: string
  SONIOX_WS_URL: string
  SONIOX_API_KEY: string
  PLUGIN_TOKEN: string
  PULL_TOKEN: string
  LINE_CHANNEL_SECRET: string
}

/** レンズに出す直近テキストの長さ。G2 は 576x288 で 400〜500 字が全画面。 */
const TAIL_CHARS = 160

/** この時間だけ音声が来なければ、相手が消えたとみなして確定保存する。 */
const IDLE_TIMEOUT_MS = 3 * 60 * 1000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/** ArrayBuffer -> 標準 base64。btoa の引数上限を避けるため分割して変換する。 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(binary)
}

/** LINE の署名検証。本文の HMAC-SHA256(base64) が x-line-signature と一致するか。 */
async function verifyLineSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !secret) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
  // 長さが違えば即座に false。同じ長さなら定数時間で比較する。
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    if (url.pathname === '/health') return json({ ok: true })

    // --- プラグインからの音声ストリーム ---
    if (url.pathname === '/ws') {
      // ブラウザの WebSocket はヘッダを付けられないのでクエリでトークンを渡す
      if (url.searchParams.get('token') !== env.PLUGIN_TOKEN) {
        return new Response('unauthorized', { status: 401 })
      }
      const sessionId = url.searchParams.get('session')
      if (!sessionId) return new Response('session required', { status: 400 })

      const stub = env.SESSION.get(env.SESSION.idFromName(sessionId))
      return stub.fetch(request)
    }

    // --- 実機 WebView の能力探査（設計判断用・一時的） ---
    if (url.pathname === '/probe') {
      if (url.searchParams.get('token') !== env.PLUGIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401)
      }
      if (request.method === 'POST') {
        const body = await request.text()
        console.log('probe:', body)
        await env.DB.prepare('INSERT INTO probes (created_at, payload) VALUES (?, ?)')
          .bind(Date.now(), body)
          .run()
        return json({ ok: true })
      }
      const { results } = await env.DB.prepare(
        'SELECT id, created_at, payload FROM probes ORDER BY id DESC LIMIT 5',
      ).all()
      return json({ probes: results ?? [] })
    }


    // --- LINE Webhook（宛先の userId を捕まえ、返信を受け取る） ---
    if (url.pathname === '/line/webhook') {
      if (request.method !== 'POST') return json({ ok: true })

      // 署名検証。これが無いと誰でも偽のイベントを投げ込める。
      const raw = await request.text()
      const signature = request.headers.get('x-line-signature') ?? ''
      if (!(await verifyLineSignature(raw, signature, env.LINE_CHANNEL_SECRET))) {
        return new Response('bad signature', { status: 401 })
      }

      let body: any
      try {
        body = JSON.parse(raw)
      } catch {
        return json({ ok: true })
      }

      const now = Date.now()
      for (const ev of body.events ?? []) {
        const userId: string | undefined = ev?.source?.userId
        if (!userId) continue

        await env.DB.prepare(
          `INSERT INTO line_users (user_id, display_name, first_seen, last_seen)
           VALUES (?, '', ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`,
        )
          .bind(userId, now, now)
          .run()

        if (ev.type === 'message' && ev.message?.type === 'text') {
          await env.DB.prepare(
            'INSERT INTO line_inbox (user_id, text, created_at) VALUES (?, ?, ?)',
          )
            .bind(userId, String(ev.message.text).slice(0, 2000), now)
            .run()
        }
      }
      // LINE は 200 以外を返すと再送してくるので、処理に失敗しても 200 を返す
      return json({ ok: true })
    }

    // --- LINE 受信箱（秘書が引き取る） ---
    if (url.pathname === '/line/pull' || url.pathname === '/line/ack') {
      if (request.headers.get('Authorization') !== `Bearer ${env.PULL_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401)
      }

      if (url.pathname === '/line/pull') {
        const { results } = await env.DB.prepare(
          `SELECT id, user_id, text, created_at FROM line_inbox
            WHERE handled = 0 ORDER BY created_at ASC LIMIT 10`,
        ).all()
        return json({ messages: results ?? [] })
      }

      const body = (await request.json().catch(() => null)) as { ids?: number[] } | null
      const ids = body?.ids ?? []
      if (!Array.isArray(ids) || ids.length === 0) return json({ acked: 0 })
      const placeholders = ids.map(() => '?').join(',')
      await env.DB.prepare(
        `UPDATE line_inbox SET handled = 1 WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .run()
      return json({ acked: ids.length })
    }

    // --- 捕まえた宛先の確認（poller が読む） ---
    if (url.pathname === '/line/users') {
      if (request.headers.get('Authorization') !== `Bearer ${env.PULL_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401)
      }
      const { results } = await env.DB.prepare(
        'SELECT user_id, first_seen, last_seen FROM line_users ORDER BY first_seen ASC',
      ).all()
      return json({ users: results ?? [] })
    }

    // --- Mac mini poller 用 ---
    if (url.pathname === '/pull' || url.pathname === '/ack') {
      if (request.headers.get('Authorization') !== `Bearer ${env.PULL_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401)
      }

      if (url.pathname === '/pull') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, 50)
        const { results } = await env.DB.prepare(
          `SELECT id, started_at, ended_at, duration_ms, transcript, lang_hints
             FROM conversations WHERE status = 'pending'
            ORDER BY created_at ASC LIMIT ?`,
        )
          .bind(limit)
          .all()
        return json({ conversations: results ?? [] })
      }

      const body = (await request.json().catch(() => null)) as { ids?: string[] } | null
      const ids = body?.ids ?? []
      if (!Array.isArray(ids) || ids.length === 0) return json({ acked: 0 })

      const placeholders = ids.map(() => '?').join(',')
      await env.DB.prepare(
        `UPDATE conversations SET status = 'delivered' WHERE id IN (${placeholders})`,
      )
        .bind(...ids)
        .run()
      return json({ acked: ids.length })
    }

    return new Response('not found', { status: 404 })
  },
}

/** 1 会話 = 1 Durable Object。プラグインの WS と Soniox の WS を持つ。 */
export class Session implements DurableObject {
  private client: WebSocket | null = null
  private soniox: WebSocket | null = null
  private sonioxReady = false
  private pending: (ArrayBuffer | string)[] = []

  /** 確定した書き起こし。話者が変わるたびに行を分ける。 */
  private lines: { speaker: string; text: string }[] = []
  /** レンズ表示用の直近テキスト。全文を毎回連結すると長い会話で無駄なので切り詰めて持つ。 */
  private tailBuffer = ''
  /** 未確定のトークン。確定したら tailBuffer 側に移る。 */
  private interim = ''
  private startedAt = 0
  private saved = false
  private langHints: string[] = ['ja', 'en']
  private keepalive: number | null = null
  private lastAlarmSetAt = 0

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    // Cloudflare のエッジは Upgrade ヘッダの大文字小文字を正規化しないので緩く見る
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    const url = new URL(request.url)
    const hints = url.searchParams.get('lang')
    if (hints) this.langHints = hints.split(',').filter(Boolean)

    const pair = new WebSocketPair()
    const [clientSide, serverSide] = Object.values(pair)
    serverSide.accept()
    // 既定では Blob で届く。Blob をそのまま転送すると Soniox はテキスト扱いして弾く。
    serverSide.binaryType = 'arraybuffer'
    this.client = serverSide
    this.startedAt = Date.now()
    this.saved = false
    // 同じ DO が再利用されることがあるので、接続ごとに書き起こしを空から始める
    // （通信断からの再接続は「続きの別セグメント」になる。二重保存を防ぐ）
    this.lines = []
    this.pending = []
    this.tailBuffer = ''
    this.interim = ''

    serverSide.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this.onControl(event.data)
      } else if (event.data instanceof ArrayBuffer) {
        this.forwardAudio(event.data)
      } else {
        // binaryType の指定が効かない環境向けの保険
        void (event.data as Blob).arrayBuffer().then((buf) => this.forwardAudio(buf))
      }
    })

    // 通信断でも書き起こしを失わない
    serverSide.addEventListener('close', () => void this.finish('client_closed'))
    serverSide.addEventListener('error', () => void this.finish('client_error'))

    await this.connectSoniox()

    return new Response(null, { status: 101, webSocket: clientSide })
  }

  private onControl(raw: string) {
    let msg: { type?: string } = {}
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'stop') {
      void this.finish('stop')
    }
  }

  /**
   * Soniox はバイナリフレームか base64 テキストのどちらかを受け付ける。
   * Workers 間のバイナリフレームは中継の途中で解釈が揺れるため、base64 テキストで送る
   * （経路は Worker→Soniox だけなので、33% の増分はスマホの通信量に影響しない）。
   */
  /**
   * 音声が途絶えたら保存する保険。
   *
   * アプリが突然落ちると WS の close が飛んでこないことがあり、その場合
   * 書き起こしが宙に浮く。マイクは無音でもフレームを送り続けるので、
   * 「フレームが来なくなった＝相手がいない」と見なせる。
   */
  private touchAlarm() {
    const now = Date.now()
    // 毎フレーム書くと storage への書き込みが多すぎるので間引く
    if (now - this.lastAlarmSetAt < 30_000) return
    this.lastAlarmSetAt = now
    void this.state.storage.setAlarm(now + IDLE_TIMEOUT_MS)
  }

  async alarm() {
    if (this.saved) return
    await this.finish('idle_timeout')
  }

  private forwardAudio(chunk: ArrayBuffer) {
    this.touchAlarm()
    const b64 = toBase64(chunk)
    if (this.soniox && this.sonioxReady) {
      this.soniox.send(b64)
    } else {
      // 接続確立前の音声を捨てない（上限を設けて暴走を防ぐ）
      if (this.pending.length < 500) this.pending.push(b64)
    }
  }

  private async connectSoniox() {
    // Workers の fetch は wss:// スキームを受け付けないので https:// に直す
    const endpoint = this.env.SONIOX_WS_URL.replace(/^wss:\/\//, 'https://').replace(
      /^ws:\/\//,
      'http://',
    )
    const resp = await fetch(endpoint, {
      headers: { Upgrade: 'websocket' },
    })
    const ws = resp.webSocket
    if (!ws) {
      this.send({ type: 'error', message: 'soniox upgrade failed' })
      return
    }
    ws.accept()
    this.soniox = ws

    ws.send(
      JSON.stringify({
        api_key: this.env.SONIOX_API_KEY,
        model: this.env.SONIOX_MODEL,
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        language_hints: this.langHints,
        enable_language_identification: true,
        enable_speaker_diarization: true,
      }),
    )
    this.sonioxReady = true

    for (const chunk of this.pending) ws.send(chunk as string)
    this.pending = []

    ws.addEventListener('message', (event: MessageEvent) => {
      this.onSonioxMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      this.sonioxReady = false
    })

    // 無音が続いてもセッションを維持する
    this.keepalive = setInterval(() => {
      if (this.soniox && this.sonioxReady) {
        this.soniox.send(JSON.stringify({ type: 'keepalive' }))
      }
    }, 10_000) as unknown as number

    this.send({ type: 'ready' })
  }

  private onSonioxMessage(raw: string) {
    let res: any
    try {
      res = JSON.parse(raw)
    } catch {
      return
    }

    if (res.error_code) {
      this.send({ type: 'error', message: `soniox ${res.error_code}: ${res.error_message ?? ''}` })
      return
    }

    // Soniox は暫定トークンを即座に、確定トークンを遅れて返す。
    // 確定だけを待つとその遅延がそのままレンズの体感遅延になるので、
    // 表示は暫定込みで即出しし、保存する transcript には確定だけを積む。
    // 暫定トークンは毎回まるごと送り直されるため、追記ではなく置き換える。
    let interim = ''
    let appendedFinal = ''

    for (const tok of res.tokens ?? []) {
      const text: string = tok.text ?? ''
      // <end> のような制御トークンは本文ではない
      if (!text || (text.startsWith('<') && text.endsWith('>'))) continue

      if (!tok.is_final) {
        interim += text
        continue
      }

      const speaker = String(tok.speaker ?? '1')
      const last = this.lines[this.lines.length - 1]
      if (last && last.speaker === speaker) {
        last.text += text
      } else {
        this.lines.push({ speaker, text })
      }
      this.tailBuffer = (this.tailBuffer + text).slice(-TAIL_CHARS)
      appendedFinal += text
    }

    if (interim !== this.interim || appendedFinal) {
      this.interim = interim
      this.send({
        type: 'text',
        // 新しいプラグインはこれを見る（暫定込みの直近テキストを丸ごと置き換える）
        tail: (this.tailBuffer + this.interim).slice(-TAIL_CHARS),
        // 旧プラグイン（v0.1.0）は text を追記する。消すと undefined を連結してしまうので、
        // 確定ぶんの差分を必ず入れておく。空文字なら追記しても無害。
        text: appendedFinal,
        chars: this.charCount(),
      })
    }
  }

  private charCount() {
    return this.lines.reduce((n, l) => n + l.text.length, 0)
  }

  private send(obj: unknown) {
    try {
      this.client?.send(JSON.stringify(obj))
    } catch {
      /* 相手が既にいない */
    }
  }

  /** finalize → 保存 → 後片付け。二重呼び出しは無視する。 */
  private async finish(reason: string) {
    if (this.saved) return
    this.saved = true

    if (this.keepalive !== null) {
      clearInterval(this.keepalive)
      this.keepalive = null
    }

    if (this.soniox && this.sonioxReady) {
      try {
        this.soniox.send(JSON.stringify({ type: 'finalize' }))
        // 確定トークンが返るのを少し待つ
        await new Promise((r) => setTimeout(r, 1500))
        this.soniox.send('') // 空テキストフレームが正しい終了合図
        await new Promise((r) => setTimeout(r, 300))
      } catch {
        /* 既に閉じている */
      }
      try {
        this.soniox.close()
      } catch {
        /* noop */
      }
    }

    const transcript = this.lines
      .map((l) => `[話者${l.speaker}] ${l.text.trim()}`)
      .filter((l) => l.length > 6)
      .join('\n')

    if (transcript.length > 0) {
      const endedAt = Date.now()
      const id = `${new Date(this.startedAt).toISOString().replace(/[:.]/g, '-')}-${this.state.id
        .toString()
        .slice(0, 8)}`
      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO conversations
           (id, started_at, ended_at, duration_ms, transcript, lang_hints, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
        .bind(
          id,
          this.startedAt,
          endedAt,
          endedAt - this.startedAt,
          transcript,
          this.langHints.join(','),
          endedAt,
        )
        .run()
      this.send({ type: 'saved', id, chars: transcript.length, reason })
    } else {
      this.send({ type: 'empty', reason })
    }

    try {
      this.client?.close(1000, reason)
    } catch {
      /* noop */
    }
  }
}
