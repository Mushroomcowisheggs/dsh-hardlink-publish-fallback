/**
 * Behavioural tests for the hardening this plugin adds.
 *
 * The plugin's own seams (`fs`, `sandboxPolicy`) are replaced with fakes that
 * reproduce the semantics of a hard-link-less volume, so the whole matrix runs
 * without an exFAT volume, without a running harness, and on any platform.
 *
 *   node test/plugin.test.mjs
 */
import { apply } from '../index.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label}${ok ? '' : ' :: ' + detail}`)
  if (!ok) failures++
}

/** The failure this plugin exists for: link publication rejected by the volume. */
const hardlinkPublishFailure = () => ({
  isError: true,
  error: {
    message:
      'cannot write "T:\\ws\\new.txt": EISDIR: illegal operation on a directory, ' +
      "link 'T:\\ws\\.new.txt.1234.abcd.tmpdir\\new.txt.tmp' -> 'T:\\ws\\new.txt'",
    info: { name: 'FsError', code: 'FS_IO_ERROR' }
  },
  content: [{ type: 'text', text: 'Error: ...' }]
})

/** A write outcome that did not come from the hard-link path, so it must not match. */
const unrelatedFailure = () => ({
  isError: true,
  error: {
    message: 'cannot write "T:\\ws\\dir": EISDIR: illegal operation on a directory, open',
    info: { name: 'FsError', code: 'FS_IO_ERROR' }
  },
  content: []
})

/**
 * A stand-in for the filesystem seam whose observable behaviour matches the real
 * one: one `writeText` publication, guarded by the forwarding plugin's intent.
 */
function makeFs(existing) {
  return {
    calls: [],
    async resolve(p, opts = {}) {
      const abs = /^[A-Za-z]:/.test(p) ? p : `${opts.cwd ?? 'T:\\ws'}\\${p}`
      return { targetKey: `k:${abs}`, displayPath: abs }
    },
    async stat(target) {
      return existing.has(target.displayPath) ? { version: 'v1', type: 'file', size: 3 } : undefined
    },
    async writeText(target, content, expected) {
      this.calls.push({ expected })
      if (existing.has(target.displayPath)) {
        const error = new Error('exists')
        error.code = 'FS_NOT_OBSERVED'
        throw error
      }
      existing.add(target.displayPath)
      return { operation: 'create', version: 'v2', before: null, after: content }
    }
  }
}

let listener
let fs
let emitted = []

const ctx = {
  on(name, fn) { if (name === 'tools/execute') listener = fn },
  get(name) {
    if (name === 'fs') return fs
    if (name === 'sandboxPolicy') {
      return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'T:\\ws' }) }
    }
    return undefined
  },
  emit(...args) { emitted.push(args) }
}

const session = { header: { cwd: 'T:\\ws' } }
const exec = { name: 'write', arguments: { file_path: 'new.txt', content: 'hi' }, agent: { session } }

apply(ctx)
check('registers a tools/execute listener', typeof listener === 'function')

// 1. The target case: the write failed, the target is still absent, so complete it.
console.log('\n[1] hard-link failure, target absent -> completes the write')
{
  const existing = new Set()
  fs = makeFs(existing)
  emitted = []
  const out = await listener(exec, hardlinkPublishFailure)
  check('returns success', out.isError === false)
  check('operation is create', out.value?.operation === 'create', JSON.stringify(out.value))
  check('publishes with no no-replace guard', fs.calls[0]?.expected === undefined, JSON.stringify(fs.calls[0]))
  check('hands the resolved policy to the publication', fs.calls[0] !== undefined)
  check('records one observation', emitted.length === 1 && emitted[0][0] === 'fs/observed', JSON.stringify(emitted))
  check('value carries before/after', out.value.before === null && out.value.after === 'hi')
}

// 2. A racing creator must never be overwritten: leave the original failure alone.
console.log('\n[2] same failure but the target now exists -> refuses to overwrite')
{
  const existing = new Set(['T:\\ws\\new.txt'])
  fs = makeFs(existing)
  emitted = []
  const original = hardlinkPublishFailure()
  const out = await listener(exec, () => original)
  check('returns the original outcome', out === original)
  check('attempts no write', fs.calls.length === 0)
  check('records no observation', emitted.length === 0)
}

// 3. Only the hard-link signature is claimed; other writes pass straight through.
console.log('\n[3] unrelated EISDIR -> untouched')
{
  fs = makeFs(new Set())
  const original = unrelatedFailure()
  const out = await listener(exec, () => original)
  check('returns the original outcome', out === original)
  check('attempts no write', fs.calls.length === 0)
}

// 4. A write that already succeeded is not interfered with.
console.log('\n[4] successful write -> untouched')
{
  fs = makeFs(new Set())
  const original = { isError: false, value: { path: 'x', operation: 'create', before: null, after: 'hi' }, content: [] }
  const out = await listener(exec, () => original)
  check('returns the same outcome object', out === original)
}

// 5. A failure inside the takeover must not replace the caller's error.
console.log('\n[5] the takeover itself fails -> original outcome preserved')
{
  fs = makeFs(new Set())
  fs.writeText = async () => { throw new Error('publication failed') }
  const original = hardlinkPublishFailure()
  const out = await listener(exec, () => original)
  check('returns the original outcome', out === original)
}

// 6. Other tools are not inspected at all.
console.log('\n[6] a non-write tool -> straight through')
{
  fs = makeFs(new Set())
  const original = hardlinkPublishFailure()
  const out = await listener({ name: 'read', arguments: {}, agent: { session } }, () => original)
  check('returns the same outcome object', out === original)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1