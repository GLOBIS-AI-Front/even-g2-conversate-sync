// src/config.ts を Keychain から生成する。トークンをリポジトリに置かないため。
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const RELAY_HOST = process.env.RELAY_HOST ?? 'conversate-relay.miyoshi-bd1.workers.dev'

const token = execFileSync(
  'security',
  ['find-generic-password', '-s', 'cred.even-conversate.plugin-token', '-w'],
  { encoding: 'utf8' },
).trim()

writeFileSync(
  new URL('../src/config.ts', import.meta.url),
  `// 自動生成: npm run gen:config （手で編集しない / コミットしない）
export const RELAY_HOST = '${RELAY_HOST}'
export const PLUGIN_TOKEN = '${token}'
export const LANG_HINTS = 'ja,en'
`,
)

console.log('src/config.ts を生成しました (host: %s)', RELAY_HOST)
