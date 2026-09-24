# `write` cannot create a new file on volumes without hard-link support (exFAT/FAT32)

## Summary

On Windows, the `write` tool cannot create a new file when the workspace sits on
a volume whose filesystem has no hard links — exFAT and FAT32 (removable drives),
and some network shares. Updating an existing file, and `edit`, keep working, so
the tool reads as flaky rather than as having lost a capability.

The publication primitive is the reason: `writeFileAtomic` publishes a **new** file
by hard-linking the staged temp file onto the target, and that link is also its
no-replace guard. Where hard links do not exist the call fails, and because the
create-if-absent intent can only be satisfied through that primitive, the failure
is terminal rather than retryable. An error-code mapping problem hides the cause:
the real failure is "this filesystem does not support hard links", reported to the
model as `EISDIR` ("illegal operation on a directory") for a path that exists as
no such thing.

## Environment

| | |
|---|---|
| OS | Windows 11 (10.0.26100.0) |
| Node | v22.20.0 |
| `dsh` | 0.1.5-rc.1 |
| `@deepseek-ai/dsh-fs-local` | 0.1.5-rc.2 |
| Workspace volume | a volume formatted exFAT (any non-hard-link filesystem reproduces it) |
| Surface | Web profile, `standard`/`cordis` preset, default `workspace-write` sandbox |

## Symptom

```
write(file_path="<workspace>\new.txt", content="x")

Error: cannot write "<workspace>\new.txt": EISDIR: illegal operation on a directory,
  link '<workspace>\.new.txt.<pid>.<uuid>.tmpdir\new.txt.tmp' -> '<workspace>\new.txt'
```

Deterministic, and true for every new file, in the workspace root and in
subdirectories alike. Overwriting an existing file in the same workspace reports
`Updated file`, and `edit` succeeds.

## Isolation of the failing primitive

On the affected volume, with the staged temp file already written, and within a
single run:

```js
fs.linkSync(temp, target)     // → code=EISDIR  errno=-4068  syscall=link
fs.renameSync(temp, target)   // → OK
```

`mkdir` of the staging directory, `open(tempPath, 'wx')`, `writeFile`, `chmod` and
`sync` all succeed. Only `link()` is rejected. The same volume also refuses
symlinks (`fs.symlinkSync` → `EISDIR`), which is a separate limitation with its own
consequences for `DSH_HOME`.

## Root cause

`packages/fs/fs-local/src/fsio.ts`, `writeFileAtomic`, the guarded-create arm:

```js
// lib/index.js:532-536
if (createIfAbsent !== void 0) try {
    await linkFile(tempPath, absolutePath);            // ← :533, EISDIR here
} catch (error) {
    await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
}
```

`throwGuardedCreateFailure` (`lib/index.js:465-478`) interprets a failing `link()`
in only two ways: contention (`EEXIST` → `FS_NOT_OBSERVED`) or an unexplained I/O
fault (**everything else** → `FS_IO_ERROR`, `:477`). `EISDIR` carries no contention
meaning, so the raw runtime message reaches the model and the operation is
abandoned.

Two related observations:

1. **The create arm has no `rename` fallback.** The replace arm (`:537-542`) falls
   back to `rename` when `ReplaceFileW` reports `ENOENT`; the create arm has none.
   Even if it did, gating on `isENOENT` would not help: `mkdir(directory,
   { recursive: true })` at `:497` runs first, so the parent always exists and
   `EISDIR` is what comes back.
2. **The sibling implementation does not have this defect.**
   `packages/fs/atomic-write` (`@deepseek-ai/dsh-atomic-write`, `lib/index.js:60-76`)
   publishes with `writeFile(temp, …, { flag: 'wx' })` plus `rename`, and never
   hard-links for this guard — so it is already compatible with hard-link-less
   volumes. The two publication implementations in the tree disagree on this point.

## Verified on the affected hardware

The `rename` fallback is not merely plausible on the affected filesystem; it has
been exercised directly on an exFAT volume. The isolation above is that
verification: `linkSync` fails with `EISDIR` while `renameSync` succeeds against
the same paths in the same run.

A separate write path was also exercised end to end: a plugin that detects this
failure signature and completes the operation through the rename publication
created new files (including in a directory it had to create), left no staging
residue, and produced files whose contents read back correctly.

## A separate defect: drive-root writes

`writeFileAtomic` begins with `mkdir(dirname(absolutePath), { recursive: true })`
(`:497`, `:543` in the shipped bundle). On Windows a drive root already exists but
`mkdir` reports it as `EPERM`, and `recursive: true` only tolerates `EEXIST`.
Verified here on two volumes of different filesystems:

```js
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir   (exFAT volume root)
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir   (NTFS volume root)
```

This is cross-filesystem and independent of the hard-link defect: it blocks writing
a new file directly at a drive root on any Windows volume, NTFS included. It also
propagates into any workaround that completes the write through the same service,
since the `mkdir` runs there too.

## Suggested fix

Treat a "this filesystem does not support hard links" failure from the link
attempt as a capability signal rather than a user-visible I/O fault, and publish
with an atomic no-clobber primitive that does not need hard links.

- Preserve no-replace: `copyFile(tempPath, absolutePath, COPYFILE_EXCL)` maps a
  racing creator to `EEXIST`, which `throwGuardedCreateFailure` already handles.
- Or fall back to `rename` when the target is still absent, accepting that on POSIX
  the no-replace guarantee degrades to best-effort inside the TOCTOU window.
- Whichever primitive is used, `EISDIR` from `link()` is a capability signal and
  should not surface as `FS_IO_ERROR`.

## Verification after a fix

- `write` creates a new file on an exFAT volume.
- `write` still refuses to clobber a concurrently created file
  (`EEXIST` → `FS_NOT_OBSERVED`).
- A second `write` to a file that was created but never read still reports
  `FS_NOT_OBSERVED`.
- An NTFS volume is unaffected.

## Existing reports

This defect has been reported before; see [PRIOR-REPORTS.md](./PRIOR-REPORTS.md) for
the list and for the analysis those threads already carry. The material above is
offered as corroborating evidence on real hardware, not as a new finding.

*(A minimal reproduction needs a filesystem that genuinely lacks hard links: a
USB stick formatted FAT32/exFAT, or a VHD created and formatted as exFAT in
Windows Disk Manager. `subst` does not work for this — it only maps a drive letter
onto a directory, so the underlying filesystem, and its hard-link support, are
unchanged.)*