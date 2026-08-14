import { listSharedSessions, importSharedSession, sameCwd, dshHome } from '../src/sharedSessions.js'

console.log('DSH_HOME =', dshHome())
const sessions = listSharedSessions()
console.log('shared sessions:', sessions.length)
for (const s of sessions) console.log(' -', s.id, '| cwd:', s.cwd, '| title:', s.title, '| created:', new Date(s.createdAt).toISOString())

if (sessions.length > 0) {
  const log = importSharedSession(sessions[0].id)
  console.log('import:', log === undefined ? 'FAILED' : `ok — meta.id=${log.meta.id}, events=${log.events.length}, first=${log.events[0]?.type}, last=${log.events[log.events.length - 1]?.type}`)
  const seqs = log?.events.map(e => e.seq) ?? []
  console.log('seqs monotonic:', seqs.every((v, i) => i === 0 || v > seqs[i - 1]))
}
console.log('sameCwd trailing slash:', sameCwd('/home/sisct/文档/', '/home/sisct/文档'))
console.log('sameCwd mismatch:', sameCwd('/a', '/b'))
