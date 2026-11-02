// Pure formatter for Telegram permission prompts (dlucian/ezri#471).
//
// Turns the `permission_request` notification fields into Telegram HTML so the
// first message shows what is about to run (the Bash command, the file path,
// the URL), not only the tool name. No I/O and no imports, so `bun test` runs
// it without a bot.
//
// Rules the callers rely on:
//   - Every interpolated value is HTML-escaped (`&` first, then `<`, `>`).
//   - Only values are ever cut, never tags, so the HTML stays balanced.
//   - Every returned message is at most `maxLength` characters of HTML source,
//     which also bounds the rendered text (escaping only adds characters).
//   - `plain` and `fullPlainParts` render their own plain text, so the
//     fallback send (no parse_mode) never shows tags or entities.

export interface PermissionRequest {
  tool_name: string
  description: string
  input_preview: string
}

export interface FormatOptions {
  /** Maximum length of one message, in characters. Clamped to 1500..4096. Default 4000. */
  maxLength?: number
}

export interface FormattedPermission {
  /** First message, as Telegram HTML. */
  html: string
  /** The same first message as plain text (no tags, no entities). */
  plain: string
  /** True when anything was cut from the first message. Drives the See more button. */
  truncated: boolean
  /** Full, uncut rendering as one HTML string. Can exceed the message limit: send `fullHtmlParts`. */
  fullHtml: string
  /** The same full rendering as plain text. Can exceed the message limit: send `fullPlainParts`. */
  fullPlain: string
  /** Full rendering split into independently valid HTML messages, each within `maxLength`. */
  fullHtmlParts: string[]
  /** Plain-text twin of `fullHtmlParts`, same length and same split points. */
  fullPlainParts: string[]
}

export const DEFAULT_MAX_LENGTH = 4000
const MIN_MAX_LENGTH = 1500
const TELEGRAM_LIMIT = 4096

// Bounds on the fixed parts, measured against the escaped length, so the
// first message always fits even when the input value is empty.
const TOOL_NAME_LIMIT = 100
const DESCRIPTION_LIMIT = 600
const SECONDARY_LIMIT = 400

// When the current chunk has room for less than this many characters of a
// block that does not fit whole, start a new chunk instead of a tiny piece.
const MIN_PIECE = 200

const CUT_NOTE = '(preview cut by Claude Code)'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// --- string helpers ---------------------------------------------------------

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Slice the first `k` UTF-16 units without leaving a lone high surrogate at the end. */
function safeSlice(s: string, k: number): string {
  if (k >= s.length) return s
  if (k <= 0) return ''
  return isHighSurrogate(s.charCodeAt(k - 1)) ? s.slice(0, k - 1) : s.slice(0, k)
}

/** Length in code points, so "N more characters" counts a non-BMP character once. */
function codePointLength(s: string): number {
  const pairs = s.match(/[\ud800-\udbff][\udc00-\udfff]/g)
  return s.length - (pairs ? pairs.length : 0)
}

/** Largest k in [0, len] for which `fits(k)` holds, assuming fits is monotone. */
function largestFit(len: number, fits: (k: number) => boolean): number {
  let lo = 0
  let hi = len
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Cut `s` so its escaped length is at most `limit`, appending an ellipsis when cut. */
function clipEscaped(s: string, limit: number): { text: string; clipped: boolean } {
  if (escapeHtml(s).length <= limit) return { text: s, clipped: false }
  const k = largestFit(s.length, n => escapeHtml(safeSlice(s, n) + '…').length <= limit)
  return { text: safeSlice(s, k) + '…', clipped: true }
}

// --- parsing ----------------------------------------------------------------

type Kind = 'pre' | 'code'

interface Primary {
  kind: Kind
  text: string
}

interface Parsed {
  primary: Primary | null
  secondary: Array<{ label: string; text: string }>
  /** The input_preview did not parse as JSON (Claude Code can send a cut preview). */
  cut: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Field names, in priority order, that carry the primary value for a tool. */
function primaryFields(tool: string): string[] {
  switch (tool) {
    case 'Bash':
      return ['command']
    case 'Edit':
    case 'Write':
    case 'Read':
      return ['file_path']
    case 'NotebookEdit':
      return ['notebook_path', 'file_path']
    case 'WebFetch':
      return ['url']
    case 'WebSearch':
      return ['query']
    case 'Glob':
    case 'Grep':
      return ['pattern']
    default:
      return []
  }
}

function primaryKind(tool: string): Kind {
  return tool === 'Bash' ? 'pre' : 'code'
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Recover the string value of `key` from a JSON text that Claude Code cut off
 * mid-string. A regex that stops at the next quote would stop at `\"`, and
 * returning the captured bytes would show raw escapes, so this scans the
 * string, decodes complete escapes, drops a partial escape at the cut, and
 * gives up (null) on an escape JSON does not define.
 */
export function recoverJsonString(raw: string, key: string): string | null {
  const start = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`).exec(raw)
  if (!start) return null
  let i = start.index + start[0].length
  let out = ''
  while (i < raw.length) {
    const c = raw[i]
    if (c === '"') break
    if (c !== '\\') {
      out += c
      i++
      continue
    }
    if (i + 1 >= raw.length) break // cut right after a backslash
    const e = raw[i + 1]
    if (e in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[e]
      i += 2
      continue
    }
    if (e === 'u') {
      const hex = raw.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]*$/.test(hex)) return null
      if (hex.length < 4) break // cut inside a \uXXXX
      out += String.fromCharCode(parseInt(hex, 16))
      i += 6
      continue
    }
    return null // not a JSON escape: do not guess
  }
  if (out.length > 0 && isHighSurrogate(out.charCodeAt(out.length - 1))) out = out.slice(0, -1)
  return out === '' ? null : out
}

function parseRequest(req: PermissionRequest): Parsed {
  const tool = req.tool_name
  const raw = req.input_preview
  if (raw.trim() === '') return { primary: null, secondary: [], cut: false }

  let parsed: unknown
  let ok = true
  try {
    parsed = JSON.parse(raw)
  } catch {
    ok = false
  }

  if (ok && isRecord(parsed)) {
    const secondary: Parsed['secondary'] = []
    if ((tool === 'Glob' || tool === 'Grep') && typeof parsed.path === 'string') {
      secondary.push({ label: 'path', text: parsed.path })
    }
    for (const field of primaryFields(tool)) {
      const v = parsed[field]
      if (typeof v === 'string') {
        return { primary: { kind: primaryKind(tool), text: v }, secondary, cut: false }
      }
    }
    // Unknown tool, or a known tool without its field (or with a non-string one).
    return { primary: { kind: 'pre', text: JSON.stringify(parsed) }, secondary, cut: false }
  }

  if (ok) {
    // Valid JSON that is not an object: an array, null, a scalar.
    return { primary: { kind: 'pre', text: raw.trim() }, secondary: [], cut: false }
  }

  // Not valid JSON: Claude Code sent a cut preview.
  for (const field of primaryFields(tool)) {
    const recovered = recoverJsonString(raw, field)
    if (recovered !== null) {
      return { primary: { kind: primaryKind(tool), text: recovered }, secondary: [], cut: true }
    }
  }
  return { primary: { kind: 'pre', text: raw }, secondary: [], cut: true }
}

// --- rendering --------------------------------------------------------------

interface Model {
  tool: string
  description: string
  primary: Primary | null
  secondary: Array<{ label: string; text: string }>
  cut: boolean
}

function wrapHtml(kind: Kind, text: string): string {
  const e = escapeHtml(text)
  return kind === 'pre' ? `<pre><code>${e}</code></pre>` : `<code>${e}</code>`
}

/** Render the first message with `primaryText` as the (possibly cut) primary value. */
function renderFirst(m: Model, primaryText: string, omitted: number): { html: string; plain: string } {
  const h: string[] = [`🔐 <b>Permission: ${escapeHtml(m.tool)}</b>`]
  const p: string[] = [`🔐 Permission: ${m.tool}`]
  if (m.description) {
    h.push(escapeHtml(m.description))
    p.push(m.description)
  }
  if (m.primary && primaryText !== '') {
    h.push('', wrapHtml(m.primary.kind, primaryText))
    p.push('', primaryText)
  }
  if (omitted > 0) {
    const marker = `… (truncated, ${omitted} more characters)`
    h.push(`<i>${marker}</i>`)
    p.push(marker)
  }
  if (m.cut) {
    h.push(`<i>${CUT_NOTE}</i>`)
    p.push(CUT_NOTE)
  }
  for (const s of m.secondary) {
    h.push(`<b>${escapeHtml(s.label)}</b>: <code>${escapeHtml(s.text)}</code>`)
    p.push(`${s.label}: ${s.text}`)
  }
  return { html: h.join('\n'), plain: p.join('\n') }
}

interface PackBlock {
  text: string
  html: (piece: string) => string
  plain: (piece: string) => string
  /** Blank line before this block. */
  gap?: boolean
}

/**
 * Pack blocks into messages of at most `max` characters of HTML. Splitting
 * happens on the plain text of a block, and each piece is escaped and wrapped
 * on its own, so a split never lands inside a tag or an entity.
 */
function pack(blocks: PackBlock[], max: number): { html: string[]; plain: string[] } {
  const outH: string[] = []
  const outP: string[] = []
  let curH = ''
  let curP = ''
  let has = false

  const flush = () => {
    if (has) {
      outH.push(curH)
      outP.push(curP)
    }
    curH = ''
    curP = ''
    has = false
  }
  const add = (h: string, p: string, gap: boolean) => {
    const sep = has ? (gap ? '\n\n' : '\n') : ''
    curH += sep + h
    curP += sep + p
    has = true
  }

  for (const b of blocks) {
    let rest = b.text
    let gap = b.gap === true
    if (rest === '') continue
    for (;;) {
      const sepLen = has ? (gap ? 2 : 1) : 0
      const avail = max - curH.length - sepLen
      if (b.html(rest).length <= avail) {
        add(b.html(rest), b.plain(rest), gap)
        break
      }
      let k = largestFit(rest.length, n => b.html(safeSlice(rest, n)).length <= avail)
      if (has && k < MIN_PIECE) {
        flush()
        continue
      }
      let next: string
      let piece: string
      const nl = rest.lastIndexOf('\n', k - 1)
      if (nl > 0 && nl > k / 2) {
        piece = rest.slice(0, nl)
        next = rest.slice(nl + 1)
      } else {
        piece = safeSlice(rest, k)
        if (piece === '') piece = rest.slice(0, isHighSurrogate(rest.charCodeAt(0)) ? 2 : 1) // always progress
        next = rest.slice(piece.length)
      }
      add(b.html(piece), b.plain(piece), gap)
      flush()
      gap = false
      rest = next
      if (rest === '') break
    }
  }
  flush()
  return { html: outH, plain: outP }
}

function fullBlocks(m: Model): PackBlock[] {
  const blocks: PackBlock[] = [
    { text: m.tool, html: t => `🔐 <b>Permission: ${escapeHtml(t)}</b>`, plain: t => `🔐 Permission: ${t}` },
  ]
  blocks.push({ text: m.description, html: escapeHtml, plain: t => t })
  if (m.primary) {
    const kind = m.primary.kind
    blocks.push({ text: m.primary.text, html: t => wrapHtml(kind, t), plain: t => t, gap: true })
  }
  if (m.cut) blocks.push({ text: CUT_NOTE, html: t => `<i>${t}</i>`, plain: t => t })
  for (const s of m.secondary) {
    blocks.push({
      text: s.text,
      html: t => `<b>${escapeHtml(s.label)}</b>: <code>${escapeHtml(t)}</code>`,
      plain: t => `${s.label}: ${t}`,
    })
  }
  return blocks
}

// --- entry point ------------------------------------------------------------

export function formatPermissionPrompt(req: PermissionRequest, opts: FormatOptions = {}): FormattedPermission {
  const max = Math.min(TELEGRAM_LIMIT, Math.max(MIN_MAX_LENGTH, Math.floor(opts.maxLength ?? DEFAULT_MAX_LENGTH)))
  const parsed = parseRequest(req)
  const full: Model = {
    tool: clipEscaped(req.tool_name, TOOL_NAME_LIMIT).text,
    description: req.description.trim(),
    primary: parsed.primary,
    secondary: parsed.secondary,
    cut: parsed.cut,
  }

  // First message: bound every fixed field, then cut only the primary value.
  const tool = clipEscaped(req.tool_name, TOOL_NAME_LIMIT)
  const desc = clipEscaped(full.description, DESCRIPTION_LIMIT)
  let clipped = tool.clipped || desc.clipped
  const secondary = full.secondary.map(s => {
    const c = clipEscaped(s.text, SECONDARY_LIMIT)
    if (c.clipped) clipped = true
    return { label: s.label, text: c.text }
  })
  const first: Model = { ...full, tool: tool.text, description: desc.text, secondary }

  const value = parsed.primary?.text ?? ''
  let rendered = renderFirst(first, value, 0)
  let truncated = clipped
  if (rendered.html.length > max) {
    truncated = true
    const attempt = (k: number) => {
      const kept = safeSlice(value, k)
      return renderFirst(first, kept, codePointLength(value) - codePointLength(kept))
    }
    let k = largestFit(value.length, n => attempt(n).html.length <= max)
    // The marker's digit count shrinks as k grows, so verify instead of trusting monotonicity.
    while (k > 0 && attempt(k).html.length > max) k--
    rendered = attempt(k)
  }

  const parts = pack(fullBlocks(full), max)
  return {
    html: rendered.html,
    plain: rendered.plain,
    truncated,
    fullHtml: parts.html.join('\n'),
    fullPlain: parts.plain.join('\n'),
    fullHtmlParts: parts.html,
    fullPlainParts: parts.plain,
  }
}
