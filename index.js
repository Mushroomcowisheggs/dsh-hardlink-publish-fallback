/**
 * Hard-link publish fallback.
 *
 * On Windows, `dsh-fs-local`'s atomic write publishes a NEW file by hard-linking
 * the staged temp file onto the target (the `createIfAbsent` path, which is the
 * no-clobber guard). Volumes without hard-link support — exFAT and FAT
 * (removable drives), and some SMB/network shares — reject that call. Node
 * surfaces the rejection as `EISDIR`, the write fails, and because the caller's
 * create-if-absent intent is never satisfied, EVERY attempt to create a new file
 * on such a volume fails forever. Updating an existing file is unaffected,
 * because that path publishes with rename/ReplaceFileW instead.
 *
 * This plugin completes exactly that failed operation:
 *
 *   1. Let the real write run, untouched.
 *   2. Only if it failed with the hard-link publish signature, re-check that the
 *      target is still absent and write it with an intent-free publication —
 *      the rename path this volume supports and that every update already uses.
 *   3. If anything about the takeover fails, return the original error unchanged.
 *
 * Default behavior is not modified: an unaffected write never enters the
 * takeover, and no row, service, or prompt section is replaced.
 *
 * @module dsh-hardlink-publish-fallback
 */

/** Plugin name used by loader diagnostics. */
export const name = 'hardlink-publish-fallback'

/**
 * The staging-directory marker in the failing call. `writeFileAtomic` stages
 * into `.${basename}.${pid}.${uuid}.tmpdir`, so its presence proves the failure
 * happened at publication rather than at open/write time.
 */
const STAGING_MARKER = '.tmpdir'

/** The tool this plugin repairs. */
const WRITE_TOOL = 'write'

/**
 * Whether an outcome is exactly the hard-link publish failure this plugin covers.
 *
 * The message has the shape
 *   link '<dir>/<name>.<pid>.<uuid>.tmpdir/<name>.tmp' -> '<target>'
 * so both the staging marker and the link verb are required. A bare `EISDIR`
 * from any other operation — a directory target, a bad path component — never
 * matches, and neither does any unguarded failure.
 *
 * @param result - the dispatch outcome to classify.
 * @returns whether this is a hard-link publication failure.
 */
function isHardlinkPublishFailure(result) {
  if (result === null || typeof result !== 'object') return false
  if (result.isError !== true) return false
  const error = result.error
  if (error === null || typeof error !== 'object') return false
  const message = error.message
  if (typeof message !== 'string') return false
  if (!message.includes(STAGING_MARKER)) return false
  return message.includes('link ')
}

/**
 * Validate the write tool's arguments the way its own parser does: only a
 * non-blank `file_path` is required, because empty content is legitimate.
 *
 * @param args - the parsed tool arguments.
 * @returns the two fields the takeover needs, or undefined when unusable.
 */
function parseWriteArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const filePath = args.file_path
  const content = args.content
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return undefined
  if (typeof content !== 'string') return undefined
  return { filePath, content }
}

/**
 * The active session of one dispatch, which supplies the workspace root the
 * filesystem tools resolve against.
 *
 * @param exec - the dispatch execution.
 * @returns the session, or undefined for a caller with no agent.
 */
function sessionOf(exec) {
  const agent = exec.agent
  if (agent === null || typeof agent !== 'object') return undefined
  const session = agent.session
  return session === null || typeof session !== 'object' ? undefined : session
}

/**
 * Register the fallback on the around-dispatch waterfall.
 *
 * @param ctx - the plugin context; the listener is an effect of this fiber.
 */
export function apply(ctx) {
  ctx.on('tools/execute', async (exec, next) => {
    // Run the real write first. Everything below is post-hoc inspection, so an
    // unaffected write takes exactly the original path.
    const result = await next()
    try {
      if (exec === null || typeof exec !== 'object') return result
      if (exec.name !== WRITE_TOOL) return result
      if (!isHardlinkPublishFailure(result)) return result
      if (exec.signal !== undefined && exec.signal.aborted) return result

      const input = parseWriteArgs(exec.arguments)
      if (input === undefined) return result

      const fs = ctx.get('fs')
      if (fs === undefined) return result
      const sandboxPolicy = ctx.get('sandboxPolicy')

      // Re-resolve through the same seam the failed call used: the session cwd
      // bases a relative path, and the resolved policy fences the substituted
      // publication to the session's workspace root.
      const session = sessionOf(exec)
      const resolveOptions = {}
      const cwd = session === undefined ? undefined : session.header.cwd
      if (typeof cwd === 'string') resolveOptions.cwd = cwd
      if (exec.signal !== undefined) resolveOptions.signal = exec.signal
      const target = await fs.resolve(input.filePath, resolveOptions)

      let policy
      if (sandboxPolicy !== undefined) {
        policy = sandboxPolicy.resolve(session === undefined ? {} : { session })
      }

      // Reaching the hard-link publish is itself proof the write was a
      // create-if-absent, so the target was absent then. Re-check it NOW so a
      // file created in the meantime is never silently overwritten.
      const existing = await fs.stat(target, exec.signal)
      if (existing !== undefined) return result

      // Publish with no no-replace guard: that selects the rename/replace path
      // this volume supports, which is the same publication every update uses.
      const outcome = await fs.writeText(target, input.content, undefined, exec.signal, policy)

      // Record the observation a successful write records, so the new file
      // behaves like any other for the rest of the session.
      const info = await fs.stat(target, exec.signal)
      if (info !== undefined) {
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      }

      // The registry re-validates this value against the write tool's own output
      // schema and re-renders it through that tool's renderer, so the model sees
      // exactly what a normal successful write produces.
      return {
        isError: false,
        value: {
          path: target.displayPath,
          operation: outcome.operation,
          before: outcome.before,
          after: outcome.after
        }
      }
    } catch {
      // Any failure in the takeover leaves the original outcome untouched.
      return result
    }
  })
}
