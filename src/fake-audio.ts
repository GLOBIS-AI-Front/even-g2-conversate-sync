/**
 * 開発用の擬似マイク。実機が無いシミュレータでも音声経路を通しで試すために使う。
 * `?fakeAudio=1` を付けたときだけ読み込まれ、本番の動作には一切影響しない。
 *
 * シミュレータは setInterval を独自にキューイングするため、自前のタイマーは持たず、
 * 呼び出し側（フラッシュタイマー）から必要なぶんだけ引いてもらう pull 方式にしている。
 */
const BYTES_PER_MS = 32 // 16kHz * 2byte / 1000

export async function loadFakeAudio(): Promise<{ next: (elapsedMs: number) => Uint8Array | null }> {
  const resp = await fetch('/dev/sample.pcm')
  const pcm = new Uint8Array(await resp.arrayBuffer())
  console.log(`[fakeAudio] ${pcm.length} bytes loaded`)

  let offset = 0
  let exhausted = false

  return {
    next(elapsedMs: number) {
      if (offset >= pcm.length) {
        if (!exhausted) {
          exhausted = true
          console.log('[fakeAudio] exhausted')
        }
        return null
      }
      const size = Math.max(1, Math.round(elapsedMs * BYTES_PER_MS))
      const chunk = pcm.subarray(offset, Math.min(offset + size, pcm.length))
      offset += chunk.length
      return chunk
    },
  }
}
