// Test fixture: a second process that appends one entry to the queue file.
// It signals readiness first, so the parent can hold the queue lock while this
// process tries to append.
//
// Usage: bun append-child.ts <queue path> <ready path> <content>
import { writeFileSync } from 'fs'
import { appendEntry } from '../../notif-queue.ts'

const [path, ready, content] = process.argv.slice(2) as [string, string, string]
writeFileSync(ready, 'ready')
appendEntry(path, { method: 'notifications/claude/channel', params: { content, meta: { chat_id: '1' } } }, Date.now(), m => console.error('child:', m))
