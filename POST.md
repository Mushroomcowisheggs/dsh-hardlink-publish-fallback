# `write` cannot create a new file on volumes without hard-link support (exFAT/FAT32)

## Already reported

This is not a new finding. The defect has been reported before, and those threads
are where the analysis lives — including the root cause, the `throwGuardedCreateFailure`
chain, the determination that `EISDIR` originates in Node/libuv rather than in dsh
(filed upstream as `nodejs/node#65817`), and reference diffs. `#3884` is the
authoritative report; `#5127` was closed by its own author as a duplicate of it;
`#5704` is the active thread. See [PRIOR-REPORTS.md](./PRIOR-REPORTS.md) for the list
and for what each already contains.

What this document adds is measurement on real hardware: the affected volume used
here is a **fixed (non-removable)** exFAT volume, and the fallback primitive that
those threads proposed from source reading — `rename` in place of the failed hard
link — was exercised directly on it, together with the collision case that must
**not** degrade. Read the earlier threads first; the sections below are
corroboration, not a new report.

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
| Workspace volume | a **fixed (non-removable)** volume formatted exFAT; any non-hard-link filesystem reproduces it |
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

## Results on the affected hardware

All results below were produced on the same machine, in one session.

### The publication primitives

With the staged temp file already written, against the same target path, in one run:

```js
fs.linkSync(temp, target)     // → code=EISDIR  errno=-4068  syscall=link
fs.renameSync(temp, target)   // → OK, content reads back correctly
```

`mkdir` of the staging directory, `open(tempPath, 'wx')`, `writeFile`, `chmod` and
`sync` all succeed in the same run. `fs.renameSync` also succeeds when the target
lies in a subdirectory that had to be created first. The same volume also refuses
symlinks (`fs.symlinkSync` → `EISDIR`).

### The fallback semantics

The guarded-create logic — link first, and on a hard-link-unsupported failure fall
back to `rename` only while the target is still absent — was exercised directly:

| Case | Result |
|---|---|
| New file (target absent) | degrades to `rename`, file published, content correct |
| Concurrent creator (target already present) | **not** degraded; the original failure is raised and the existing content is preserved byte-for-byte |
| Staging file after a successful fallback | consumed by the publish, no residue |

The collision path is untouched by the fallback: `EEXIST` is deliberately not part
of the "hard links unsupported" set, so a genuine race still reports contention
instead of silently overwriting.

### NTFS is unaffected

On an NTFS volume, `fs.linkSync` succeeds and the resulting paths **share an inode**
— a real hard link, not a copy. So the existing create-if-absent path on NTFS
keeps behaving exactly as before, and the fallback never engages there.

### What this does not establish

The reference diffs in the existing threads were **not** applied: doing so means
modifying an installed DSH runtime, which was out of scope here. What is verified
is that the primitives and the fallback logic those diffs rely on behave as the
diffs assume on the affected filesystem — not that a patched build passes.

A separate end-to-end check was also run: a plugin that detects this failure
signature and completes the write through the rename publication created new
files, including inside a directory it had to create, with no staging residue and
with contents that read back correctly, while writes that did not match the
signature were passed through untouched.
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

*(A minimal reproduction needs a filesystem that genuinely lacks hard links: a
USB stick formatted FAT32/exFAT, or a VHD created and formatted as exFAT in
Windows Disk Manager. `subst` does not work for this — it only maps a drive letter
onto a directory, so the underlying filesystem, and its hard-link support, are
unchanged.)*