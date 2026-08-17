/**
 * 実機の WebView が何を持っているかを調べる探査。
 *
 * 目的は 1 つ: **iPhone 側の音声認識（Web Speech API）をプラグインから使えるか**。
 * 使えるなら音声をクラウドへ送らずに済み、公式 Conversate と同じ土俵に立てる。
 * 使えないなら設計を変える必要があるので、作り込む前にここで判定する。
 *
 * 結果は relay の /probe に送って D1 に残す（レンズは狭くて全部は読めないため）。
 */
import { RELAY_HOST, PLUGIN_TOKEN } from './config'

export type ProbeResult = {
  ua: string
  hasSpeechRecognition: boolean
  hasWebkitSpeechRecognition: boolean
  hasGetUserMedia: boolean
  hasMediaRecorder: boolean
  /** 実際に start() してみた結果 */
  startOutcome: string
  /** 認識結果が返ってきたか */
  gotResult: boolean
  sample: string
}

function detect(): Omit<ProbeResult, 'startOutcome' | 'gotResult' | 'sample'> {
  const w = window as any
  return {
    ua: navigator.userAgent,
    hasSpeechRecognition: typeof w.SpeechRecognition === 'function',
    hasWebkitSpeechRecognition: typeof w.webkitSpeechRecognition === 'function',
    hasGetUserMedia: !!navigator.mediaDevices?.getUserMedia,
    hasMediaRecorder: typeof w.MediaRecorder === 'function',
  }
}

/**
 * 音声認識を実際に起動してみる。マイク許可のダイアログが出る可能性がある。
 * 8 秒待って何も起きなければ諦める。
 */
function trySpeechRecognition(): Promise<{ outcome: string; gotResult: boolean; sample: string }> {
  const w = window as any
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (typeof Ctor !== 'function') {
    return Promise.resolve({ outcome: 'not_available', gotResult: false, sample: '' })
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (outcome: string, gotResult = false, sample = '') => {
      if (settled) return
      settled = true
      try {
        rec.stop()
      } catch {
        /* noop */
      }
      resolve({ outcome, gotResult, sample })
    }

    let rec: any
    try {
      rec = new Ctor()
    } catch (e: any) {
      resolve({ outcome: `construct_failed: ${e?.message ?? e}`, gotResult: false, sample: '' })
      return
    }

    rec.lang = 'ja-JP'
    rec.continuous = true
    rec.interimResults = true

    rec.onstart = () => console.log('[probe] recognition started')
    rec.onerror = (e: any) => done(`error: ${e?.error ?? 'unknown'}`)
    rec.onresult = (e: any) => {
      const text = e.results?.[e.results.length - 1]?.[0]?.transcript ?? ''
      done('got_result', true, String(text).slice(0, 60))
    }

    try {
      rec.start()
    } catch (e: any) {
      done(`start_threw: ${e?.message ?? e}`)
      return
    }

    // 何も起きない（無音・許可待ちのまま）ケース
    setTimeout(() => done('started_but_silent'), 8000)
  })
}

export async function runProbe(): Promise<ProbeResult> {
  const base = detect()
  const { outcome, gotResult, sample } = await trySpeechRecognition()
  const result: ProbeResult = { ...base, startOutcome: outcome, gotResult, sample }

  console.log('[probe]', JSON.stringify(result))

  try {
    await fetch(`https://${RELAY_HOST}/probe?token=${encodeURIComponent(PLUGIN_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    })
  } catch (e) {
    console.warn('[probe] report failed', e)
  }

  return result
}

/** レンズに出す 1 行サマリ。 */
export function probeSummary(r: ProbeResult): string {
  const sr = r.hasSpeechRecognition || r.hasWebkitSpeechRecognition
  if (!sr) return '音声認識API: 無し'
  if (r.gotResult) return `音声認識API: 動作OK「${r.sample}」`
  return `音声認識API: 有るが ${r.startOutcome}`
}
