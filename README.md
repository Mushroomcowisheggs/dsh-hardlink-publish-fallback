# dsh-hardlink-publish-fallback

Completes a `write` tool call that failed because the volume cannot publish a new
file by hard link.

## The problem it solves

On Windows, `@deepseek-ai/dsh-fs-local` publishes a **new** file by hard-linking
its staged temp file onto the target. That link is the no-clobber guard: it
refuses to overwrite a file that appeared since the write intent was decided.

Volumes without hard-link support — **exFAT**, **FAT32** (removable drives), and
some network shares — reject the call. Node surfaces the rejection as `EISDIR`
(not `ENOTSUP`/`EPERM`), so the write fails with:

```
cannot write "<workspace>\<file>": EISDIR: illegal operation on a directory,
  link '<workspace>\.<file>.<pid>.<uuid>.tmpdir\<file>.tmp' -> '<workspace>\<file>'
```

Because the caller's create-if-absent intent is never satisfied, **every attempt
to create a new file in that workspace fails**, permanently. Updating an existing
file is unaffected: that path publishes with rename/ReplaceFileW instead. The
result is a confusing half-broken tool — "edits work, creating never does".

The same volumes also lack **symbolic links**, which is a separate and more
severe limitation for `dsh` itself: `dsh-app-boot`'s `healProfilesModuleFallback`
symlinks the install into the profile at composition time, so a `DSH_HOME` placed
on such a volume cannot boot any profile at all. This plugin does not address
that; keep `DSH_HOME` on a symlink-capable filesystem.

## What this plugin does

1. Lets the real `write` run, untouched.
2. Only if it failed with the hard-link publish signature, re-checks that the
   target is still absent, then publishes with an intent-free write — the rename
   path the volume supports, and the one every file update already uses.
3. Records the same observation a successful write records.
4. If anything in the takeover fails, returns the original error unchanged.

**Default behavior is not modified.** An unaffected write never enters the
takeover, no existing row is overridden, and no service is replaced. Detection is
strict: both the `.tmpdir` staging marker and the `link ` verb must be present in
a `FS_IO_ERROR` message, so unrelated `EISDIR` failures (a directory target, a bad
path component) are never touched.

## Install

Install from GitHub. Pin a tag or commit — without a ref, pnpm installs whatever
the default branch points at *now*, so a later push would silently change what
runs on users' machines:

```sh
dsh plugin --profile web add "github:Mushroomcowisheggs/dsh-hardlink-publish-fallback#v0.1.0"

# strongest: pin the exact commit
dsh plugin --profile web add "github:Mushroomcowisheggs/dsh-hardlink-publish-fallback#<40-char-sha>"
```

This package is plain JavaScript with **no `prepare`/build script**, so pnpm has
no lifecycle script to run and no `allowBuilds` authorization is needed. (That
requirement applies to git dependencies that build from source; if a future
version ever gains a build step, users must allowlist it in the profile's
`pnpm-workspace.yaml`.)

### Always quote paths

When installing from a local checkout or a tarball, **double-quote the path**. An
unquoted Windows path is mangled before pnpm ever sees it: sequences such as `\d`,
`\h`, and `\t` are read as escapes, so

```sh
# WRONG — backslash escapes eat path separators; pnpm then looks for a
# registry package literally named "dir\my-plugin"
dsh plugin --profile web add some\dir\my-plugin

# RIGHT
dsh plugin --profile web add "some\dir\my-plugin"
```

```sh
# from a local checkout
dsh plugin --profile web add "<path-to-checkout>"

# from a tarball
pnpm pack
dsh plugin --profile web add "<path-to-checkout>\dsh-hardlink-publish-fallback-0.1.0.tgz"
```

`dsh plugin add` appends the bundle to the profile's `dsh.profile.bundles`
automatically, because this package declares `dsh.bundle`.

## Verify

```sh
dsh --profile web --dump-config          # look for "# == dsh-hardlink-publish-fallback"
```

Then, in a workspace on the affected volume, ask the agent to create a new file.
Without the plugin it fails with the `EISDIR`/`link` error above; with it the call
reports `Created file` as normal.

Confirmed on real hardware (fixed exFAT volume, plugin installed from the published
tag): new-file creation, creation inside a directory that had to be made, a second
write to the same file without an intervening read, and no staging residue. Files
this plugin creates record the same observation a normal successful write records,
so they behave like any other file afterwards.

## Scope and limitations

- **Only repairs new-file creation.** Updates and `edit` never used the hard-link
  path, so they are already fine and are not intercepted.
- **Windows-oriented symptom, host-agnostic logic.** The plugin keys on the
  failure signature, not on the platform, so it also covers any POSIX filesystem
  that refuses `link()` with the same shape.
- **Does not help when writing to a drive root.** A separate, cross-filesystem
  defect makes `writeFileAtomic` call `mkdir(<root>, { recursive: true })`,
  which returns `EPERM` on Windows drive roots (verified here on both an NTFS and
  an exFAT volume). Because this plugin completes the write through the same
  service, a new file written directly at a drive root still fails. Use a subdirectory.
- **Not a substitute for an upstream fix.** This is a runtime workaround for a
  defect in `dsh-fs-local`'s publication logic; see
  [DEFECT-REPORT.md](./DEFECT-REPORT.md) for the full analysis and a proposed fix.
- **A small, inherited TOCTOU window.** The absence re-check and the write are
  separate calls. This is the same window the original `writeText` already has
  between its own probe and its publication; the no-clobber guard is what the
  re-check preserves, and a racing creator still cannot be silently overwritten
  beyond that window.

## Testing

```sh
npm test          # or: node test/plugin.test.mjs
```

The suite replaces the plugin's seams (`fs`, `sandboxPolicy`) with fakes that
reproduce the semantics of a hard-link-less volume, so it needs no exFAT volume, no
running harness, and no dependencies — it runs anywhere Node runs. It asserts the
outcomes that matter for this plugin's contract: the hard-link failure is completed
without a no-replace guard, a target that exists by the time the takeover runs is
**never** overwritten, unrelated failures and successful writes are passed through
untouched, and a failure inside the takeover leaves the caller's original outcome
in place.
## Repository layout

```
.
├── package.json           # declares dsh.bundle.patch
├── cordis.patch.yml       # the configuration layer this bundle contributes
├── index.js               # the plugin module
├── README.md
├── LICENSE
├── test/
│   └── plugin.test.mjs    # behavioural tests (no exFAT volume needed)
├── DEFECT-REPORT.md       # the upstream analysis (not published to npm)
├── POST.md                # candidate discussion write-up (see PRIOR-REPORTS.md)
└── PRIOR-REPORTS.md       # this defect is already reported - read before filing
```

The package files must stay at the repository **root**: a git install packs the
whole repository rather than applying the `files` allowlist, so `package.json`,
`index.js`, and `cordis.patch.yml` all have to resolve from the root.

## Discovery

The repository carries the GitHub `dsh-plugin` topic, which is how
`CONTRIBUTING.md` asks community plugins to make themselves discoverable.

## License

MIT — see [LICENSE](./LICENSE).