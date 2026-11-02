import { describe, expect, test } from 'bun:test'
import { escapeHtml, formatPermissionPrompt, recoverJsonString } from '../permission-format.ts'

const MAX = 4000

function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Every tag is one of the four we emit, tags nest, and no raw `<`, `>` or loose `&` is left. */
function assertValidHtml(html: string): void {
  const stack: string[] = []
  const re = /<(\/?)(b|i|pre|code)>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] === '') stack.push(m[2])
    else expect(stack.pop()).toBe(m[2])
  }
  expect(stack).toEqual([])
  const text = html.replace(/<\/?(b|i|pre|code)>/g, '')
  expect(text).not.toMatch(/[<>]/)
  expect(text).not.toMatch(/&(?!(amp|lt|gt);)/)
}

function codeContent(html: string): string {
  const m = /<pre><code>([\s\S]*)<\/code><\/pre>/.exec(html)
  if (!m) throw new Error(`no pre block in: ${html}`)
  return unescape(m[1])
}

function bash(command: string, extra: Record<string, unknown> = {}, description = 'Run a command') {
  return { tool_name: 'Bash', description, input_preview: JSON.stringify({ command, ...extra }) }
}

describe('Bash', () => {
  test('renders the command in a code block in the first message', () => {
    const r = formatPermissionPrompt(bash('git status --short'))
    expect(r.html).toContain('🔐 <b>Permission: Bash</b>')
    expect(r.html).toContain('Run a command')
    expect(r.html).toContain('<pre><code>git status --short</code></pre>')
    expect(r.truncated).toBe(false)
    expect(r.html).not.toContain('truncated')
    assertValidHtml(r.html)
  })

  test('renders <, >, &, quotes, and backticks verbatim', () => {
    const command = `echo "a < b" && cat <<'EOF' > out.txt\n\`date\` & 'x' > /dev/null\nEOF`
    const r = formatPermissionPrompt(bash(command))
    expect(r.html).toContain('&amp;&amp;')
    expect(r.html).toContain('&lt;&lt;')
    expect(r.html).toContain('echo "a &lt; b"') // quotes pass through unescaped
    expect(r.html).toContain('`date`')
    expect(codeContent(r.html)).toBe(command)
    assertValidHtml(r.html)
  })

  test('escapes the tool name and description too', () => {
    const r = formatPermissionPrompt({
      tool_name: 'mcp__x<y>',
      description: 'a & b <script>',
      input_preview: '{}',
    })
    expect(r.html).toContain('Permission: mcp__x&lt;y&gt;</b>')
    expect(r.html).toContain('a &amp; b &lt;script&gt;')
    assertValidHtml(r.html)
  })
})

describe('truncation', () => {
  test('boundary: a command that fits is not truncated, one more character is', () => {
    const overhead = formatPermissionPrompt(bash('x')).html.length - 1
    const fits = formatPermissionPrompt(bash('x'.repeat(MAX - overhead)), { maxLength: MAX })
    expect(fits.html.length).toBe(MAX)
    expect(fits.truncated).toBe(false)
    const over = formatPermissionPrompt(bash('x'.repeat(MAX - overhead + 1)), { maxLength: MAX })
    expect(over.truncated).toBe(true)
  })

  test('cuts only the value, counts the cut characters, keeps the HTML balanced', () => {
    const command = 'a&b '.repeat(3000) // 12,000 characters, 4x expansion when escaped
    const r = formatPermissionPrompt(bash(command))
    expect(r.truncated).toBe(true)
    expect(r.html.length).toBeLessThanOrEqual(MAX)
    assertValidHtml(r.html)
    const kept = codeContent(r.html)
    expect(command.startsWith(kept)).toBe(true)
    const m = /… \(truncated, (\d+) more characters\)/.exec(r.html)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(command.length - kept.length)
    // The cut sits as close to the limit as the escaping allows.
    expect(r.html.length).toBeGreaterThan(MAX - 20)
    // Plain fallback carries the same kept text and marker, with no markup.
    expect(r.plain).toContain(kept)
    expect(r.plain).not.toMatch(/<\/?(pre|code|b|i)>|&amp;/)
  })

  test('counts a non-BMP character once and never leaves a lone surrogate', () => {
    const command = '😀'.repeat(3000)
    const r = formatPermissionPrompt(bash(command))
    expect(r.truncated).toBe(true)
    const kept = codeContent(r.html)
    expect(kept).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    const m = /truncated, (\d+) more/.exec(r.html)!
    expect(Number(m[1])).toBe(3000 - [...kept].length)
  })

  test('a huge description and tool name still leave a first message under the limit', () => {
    const r = formatPermissionPrompt({
      tool_name: 'T&'.repeat(500),
      description: '<d>&'.repeat(2000),
      input_preview: JSON.stringify({ command: 'ls ' + 'y'.repeat(10000) }),
    })
    expect(r.html.length).toBeLessThanOrEqual(MAX)
    expect(r.truncated).toBe(true)
    expect(r.html).toContain('…')
    assertValidHtml(r.html)
    expect(r.plain.length).toBeLessThanOrEqual(r.html.length)
  })

  test('a long file path in a secondary field is bounded', () => {
    const r = formatPermissionPrompt({
      tool_name: 'Grep',
      description: '',
      input_preview: JSON.stringify({ pattern: 'foo', path: '/a/&/'.repeat(500) }),
    })
    expect(r.html.length).toBeLessThanOrEqual(MAX)
    expect(r.truncated).toBe(true)
    assertValidHtml(r.html)
  })

  test('clamps maxLength to the Telegram limit', () => {
    const r = formatPermissionPrompt(bash('z'.repeat(9000)), { maxLength: 100000 })
    expect(r.html.length).toBeLessThanOrEqual(4096)
  })
})

describe('See more expansion', () => {
  test('splits a long command into balanced messages that reassemble to the original', () => {
    const command = Array.from({ length: 900 }, (_, i) => `echo "line ${i}" && cat <in >out`).join('\n')
    const r = formatPermissionPrompt(bash(command))
    expect(r.fullHtmlParts.length).toBeGreaterThanOrEqual(3)
    expect(r.fullPlainParts.length).toBe(r.fullHtmlParts.length)
    for (const part of r.fullHtmlParts) {
      expect(part.length).toBeLessThanOrEqual(MAX)
      assertValidHtml(part)
    }
    for (const part of r.fullPlainParts) {
      expect(part.length).toBeLessThanOrEqual(MAX)
      expect(part).not.toMatch(/<\/?(pre|code|b|i)>|&amp;|&lt;/)
    }
    const rebuilt = r.fullHtmlParts.map(p => (/<pre><code>([\s\S]*)<\/code><\/pre>/.exec(p) ? codeContent(p) : '')).filter(Boolean)
    expect(rebuilt.join('\n')).toBe(command)
    expect(r.fullHtmlParts[0]).toContain('Permission: Bash')
  })

  test('a hard split with no newlines never cuts an entity or a tag', () => {
    const command = '&<>'.repeat(5000)
    const r = formatPermissionPrompt(bash(command))
    expect(r.fullHtmlParts.length).toBeGreaterThanOrEqual(3)
    for (const part of r.fullHtmlParts) {
      expect(part.length).toBeLessThanOrEqual(MAX)
      assertValidHtml(part)
    }
    const rebuilt = r.fullHtmlParts.map(p => (/<pre><code>/.test(p) ? codeContent(p) : '')).join('')
    expect(rebuilt).toBe(command)
  })

  test('a split never separates a surrogate pair', () => {
    const command = '😀&'.repeat(4000)
    const r = formatPermissionPrompt(bash(command))
    expect(r.fullHtmlParts.length).toBeGreaterThanOrEqual(3)
    for (const part of r.fullHtmlParts) {
      expect(part).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      expect(part.length).toBeLessThanOrEqual(MAX)
    }
    const rebuilt = r.fullHtmlParts.map(p => (/<pre><code>/.test(p) ? codeContent(p) : '')).join('')
    expect(rebuilt).toBe(command)
  })

  test('a command that fits has a single full part equal to the first message', () => {
    const r = formatPermissionPrompt(bash('ls'))
    expect(r.fullHtmlParts).toEqual([r.html])
    expect(r.fullHtml).toBe(r.html)
    expect(r.fullPlainParts).toEqual([r.plain])
  })

  test('the full rendering keeps the whole description', () => {
    const description = 'word '.repeat(400).trim()
    const r = formatPermissionPrompt({ ...bash('ls'), description })
    expect(r.truncated).toBe(true)
    expect(r.fullPlain).toContain(description)
  })
})

describe('other tools', () => {
  test('Edit shows file_path in an inline code span', () => {
    const r = formatPermissionPrompt({
      tool_name: 'Edit',
      description: 'Edit a file',
      input_preview: JSON.stringify({ file_path: '/src/a&b/<x>.ts', old_string: 'o', new_string: 'n' }),
    })
    expect(r.html).toContain('<code>/src/a&amp;b/&lt;x&gt;.ts</code>')
    expect(r.html).not.toContain('<pre>')
    expect(r.html).not.toContain('old_string')
    assertValidHtml(r.html)
  })

  test('NotebookEdit prefers notebook_path, WebFetch shows url, WebSearch shows query', () => {
    const nb = formatPermissionPrompt({
      tool_name: 'NotebookEdit',
      description: '',
      input_preview: JSON.stringify({ notebook_path: '/n.ipynb', file_path: '/other' }),
    })
    expect(nb.html).toContain('<code>/n.ipynb</code>')
    const web = formatPermissionPrompt({
      tool_name: 'WebFetch',
      description: '',
      input_preview: JSON.stringify({ url: 'https://x.test/?a=1&b=2' }),
    })
    expect(web.html).toContain('<code>https://x.test/?a=1&amp;b=2</code>')
    const search = formatPermissionPrompt({
      tool_name: 'WebSearch',
      description: '',
      input_preview: JSON.stringify({ query: 'bun test' }),
    })
    expect(search.html).toContain('<code>bun test</code>')
  })

  test('Grep and Glob show the pattern plus path when present', () => {
    const r = formatPermissionPrompt({
      tool_name: 'Grep',
      description: '',
      input_preview: JSON.stringify({ pattern: 'foo.*bar', path: '/repo' }),
    })
    expect(r.html).toContain('<code>foo.*bar</code>')
    expect(r.html).toContain('<b>path</b>: <code>/repo</code>')
    const noPath = formatPermissionPrompt({
      tool_name: 'Glob',
      description: '',
      input_preview: JSON.stringify({ pattern: '**/*.ts' }),
    })
    expect(noPath.html).toContain('<code>**/*.ts</code>')
    expect(noPath.html).not.toContain('path')
  })

  test('an unknown tool shows compact JSON', () => {
    const r = formatPermissionPrompt({
      tool_name: 'mcp__srv__do',
      description: 'Do it',
      input_preview: '{\n  "a": 1,\n  "b": "<x>"\n}',
    })
    expect(r.html).toContain('<pre><code>{"a":1,"b":"&lt;x&gt;"}</code></pre>')
    assertValidHtml(r.html)
  })

  test('a known tool without its field, or with a non-string one, falls back to compact JSON', () => {
    const missing = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: '{"timeout":5}' })
    expect(missing.html).toContain('{"timeout":5}')
    const wrongType = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: '{"command":["ls"]}' })
    expect(wrongType.html).toContain('{"command":["ls"]}')
  })

  test('valid JSON that is not an object is shown as is', () => {
    for (const raw of ['null', '[1,2]', '"hi"', '42']) {
      const r = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: raw })
      expect(r.html).toContain(`<pre><code>${raw}</code></pre>`)
      expect(r.html).not.toContain('preview cut')
    }
  })

  test('an empty input_preview renders header and description only', () => {
    const r = formatPermissionPrompt({ tool_name: 'Bash', description: 'd', input_preview: '' })
    expect(r.html).toBe('🔐 <b>Permission: Bash</b>\nd')
    expect(r.fullHtmlParts).toEqual([r.html])
  })
})

describe('input_preview that does not parse', () => {
  test('shows the raw string and marks it as a cut preview', () => {
    const r = formatPermissionPrompt({ tool_name: 'Mystery', description: '', input_preview: '{"a": "b<' })
    expect(r.html).toContain('<pre><code>{"a": "b&lt;</code></pre>')
    expect(r.html).toContain('<i>(preview cut by Claude Code)</i>')
    expect(r.plain).toContain('(preview cut by Claude Code)')
    assertValidHtml(r.html)
  })

  test('recovers a Bash command cut mid-string, decoding quotes, backslashes, and newlines', () => {
    const raw = String.raw`{"command":"echo \"hi\" && cat C:\\dir\nsecond line \u00e9 <x>`
    const r = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: raw })
    expect(codeContent(r.html)).toBe('echo "hi" && cat C:\\dir\nsecond line é <x>')
    expect(r.html).toContain('<i>(preview cut by Claude Code)</i>')
    assertValidHtml(r.html)
  })

  test('recoverJsonString handles each cut position and rejects bad escapes', () => {
    expect(recoverJsonString(String.raw`{"command":"a\"b`, 'command')).toBe('a"b')
    expect(recoverJsonString(String.raw`{"command":"a\\`, 'command')).toBe('a\\')
    expect(recoverJsonString(String.raw`{"command":"a\n`, 'command')).toBe('a\n')
    // cut right after the backslash, or inside a \u escape: the partial escape is dropped
    expect(recoverJsonString('{"command":"abc\\', 'command')).toBe('abc')
    expect(recoverJsonString('{"command":"abc\\u00', 'command')).toBe('abc')
    // a complete string followed by more JSON stops at the closing quote
    expect(recoverJsonString('{"command":"ls","timeout":', 'command')).toBe('ls')
    // an escape JSON does not define, or a bad hex digit: do not guess
    expect(recoverJsonString(String.raw`{"command":"a\qb`, 'command')).toBeNull()
    expect(recoverJsonString('{"command":"a\\uZZZZ', 'command')).toBeNull()
    // nothing to recover
    expect(recoverJsonString('{"command":"', 'command')).toBeNull()
    expect(recoverJsonString('{"other":"x', 'command')).toBeNull()
  })

  test('a bad escape falls back to the raw preview', () => {
    const raw = String.raw`{"command":"a\qb`
    const r = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: raw })
    expect(codeContent(r.html)).toBe(raw)
  })

  test('does not drop a trailing lone surrogate escape', () => {
    const r = formatPermissionPrompt({ tool_name: 'Bash', description: '', input_preview: String.raw`{"command":"ok \ud83d` })
    expect(codeContent(r.html)).toBe('ok ')
  })
})

describe('plain-text fallback', () => {
  test('renders its own text, not the HTML string', () => {
    const command = 'a < b && c > d'
    const r = formatPermissionPrompt(bash(command, {}, 'x & y'))
    expect(r.plain).toBe(`🔐 Permission: Bash\nx & y\n\n${command}`)
    expect(r.plain).not.toMatch(/<\/?(pre|code|b|i)>/)
    expect(r.plain).not.toContain('&amp;')
  })
})

test('escapeHtml escapes & first', () => {
  expect(escapeHtml('&lt; <>')).toBe('&amp;lt; &lt;&gt;')
})
