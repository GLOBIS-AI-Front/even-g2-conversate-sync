/**
 * 作者の環境の値を、自分の環境の値に一括で差し替える。
 *
 *   npm run configure -- --worker my-relay --subdomain my-account --d1 <database_id>
 *
 * 書き換える先:
 *   relay/wrangler.jsonc … Worker 名 / D1 の database_id / database_name
 *   app.json             … 通信先ホワイトリスト（Even Hub はここに無いドメインを一切許可しない）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const get = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const worker = get('worker')
const subdomain = get('subdomain')
const d1 = get('d1')
const db = get('db') ?? worker

if (!worker || !subdomain || !d1) {
  console.error(`使い方:
  npm run configure -- --worker <Worker名> --subdomain <workers.devサブドメイン> --d1 <database_id> [--db <D1のDB名>]

  例: npm run configure -- --worker conversate-relay --subdomain my-account --d1 9c92f14f-...

  サブドメインは 'npx wrangler whoami' か Cloudflare ダッシュボードで確認できる。
  --db を省略すると Worker 名と同じ名前の D1 データベースを指す。`)
  process.exit(1)
}

const host = `${worker}.${subdomain}.workers.dev`
const url = (p) => new URL(p, import.meta.url)

// --- relay/wrangler.jsonc （コメント付き JSON なのでパースせず該当行だけ置換する）
const wranglerPath = url('../relay/wrangler.jsonc')
let wrangler = readFileSync(wranglerPath, 'utf8')
wrangler = wrangler
  .replace(/("name"\s*:\s*)"[^"]*"/, `$1"${worker}"`)
  .replace(/("database_name"\s*:\s*)"[^"]*"/, `$1"${db}"`)
  .replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${d1}"`)
writeFileSync(wranglerPath, wrangler)

// --- app.json
const appPath = url('../app.json')
const app = JSON.parse(readFileSync(appPath, 'utf8'))
const net = app.permissions.find((p) => p.name === 'network')
if (!net) throw new Error('app.json に network 権限がありません')
net.whitelist = [`https://${host}`, `wss://${host}`]
writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n')

console.log(`書き換えました。
  Worker      : ${worker}
  D1          : ${db} (${d1})
  通信先       : ${host}

次にやること:
  cd relay && npx wrangler d1 execute ${db} --remote --file ./schema.sql
  （その後シークレットを登録して deploy。docs/SETUP.md の手順 3-3 以降）

app.json の package_id も自分のものに変えること（現在: ${app.package_id}）。`)
