# Measurements on the exFAT hard-link publication failure

## Context

The `write` tool cannot create a new file on a volume whose filesystem has no hard
links (exFAT, FAT32, some network shares), while updating an existing file and
`edit` keep working. The defect, its root cause, and reference diffs are already
documented: `#3884` is the authoritative report, `#5127` was closed as its
duplicate, and `#5704` is the active thread — which established that the misleading
`EISDIR` originates in Node/libuv, filed upstream as `nodejs/node#65817`. See
[PRIOR-REPORTS.md](./PRIOR-REPORTS.md).

This document does not restate that analysis. It records what was measured on a
real affected volume.

| | |
|---|---|
| OS | Windows 11 (10.0.26100.0) |
| Node | v22.20.0 |
| `dsh` | 0.1.5-rc.1 |
| `@deepseek-ai/dsh-fs-local` | 0.1.5-rc.2 |
| Volume | a **fixed (non-removable)** volume formatted exFAT |

The volume being fixed rather than removable matters: the failure tracks the
filesystem, not whether the drive is a USB device.

For reference, the failure signature produced by the tool is:

```
cannot write "<workspace>\<file>": EISDIR: illegal operation on a directory,
  link '<workspace>\.<file>.<pid>.<uuid>.tmpdir\<file>.tmp' -> '<workspace>\<file>'
```

Deterministic for every new file, in the workspace root and in subdirectories
alike; overwriting an existing file reports `Updated file` and `edit` succeeds.

## What this adds

On `#5704` the fallback to `rename` was proposed from source reading and left
unverified on hardware — `rename`-on-exFAT was stated as an assumption, with a
request to confirm it. The measurement below confirms it, and additionally
exercises the collision case that must **not** take the fallback.

## Measured results

### Publication primitives

With the staged temp file already written, against the same target path, in one run:

```js
fs.linkSync(temp, target)     // → code=EISDIR  errno=-4068  syscall=link
fs.renameSync(temp, target)   // → OK, content reads back correctly
```

`mkdir` of the staging directory, `open(tempPath, 'wx')`, `writeFile`, `chmod` and
`sync` all succeed in the same run. `fs.renameSync` equally succeeds into a
subdirectory that had to be created first. The volume also refuses symlinks
(`fs.symlinkSync` → `EISDIR`), which is a second capability gap with its own
consequences for `DSH_HOME`.

### Fallback semantics

The guarded-create logic — attempt the link, and on a hard-link-unsupported failure
degrade to `rename` only while the target is still absent — was exercised directly,
one case per row:

| Case | Result |
|---|---|
| New file, target absent | degrades to `rename`; file published; content correct |
| Concurrent creator, target already present | **no** degradation; the original failure is raised and the existing content survives byte-for-byte |
| Staging file after a successful fallback | consumed by the publication; no residue |

The collision path is deliberately outside the fallback: `EEXIST` is not a
hard-link-unsupported signal, so a genuine race still reports contention rather
than overwriting.

### NTFS is unaffected

On an NTFS volume the same call succeeds and the two paths **share an inode** — a
real hard link, not a copy. The existing create-if-absent publication therefore
behaves exactly as before on NTFS, and the fallback never engages there.

### Drive roots fail independently, on every filesystem

`writeFileAtomic` begins with `mkdir(dirname(target), { recursive: true })`. On
Windows a drive root already exists but `mkdir` reports `EPERM`, and
`recursive: true` tolerates only `EEXIST`:

```js
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir  (exFAT root)
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir  (NTFS root)
```

This is independent of hard links and reproduces on both filesystems, so it blocks
writing a new file directly at a drive root on any Windows volume — including NTFS.
It also propagates into any workaround that completes the write through the same
service, since that `mkdir` runs there too.

## What was not established

The reference diffs in the existing threads were not applied — that means modifying
an installed DSH runtime, which was out of scope. What is verified is that the
primitives and the fallback logic those diffs rely on behave as the diffs assume on
the affected filesystem, not that a patched build passes.

One end-to-end check was run on top of the measurements: a plugin that detects this
failure signature and completes the write through the rename publication created
new files (including inside a directory it had to create), left no staging residue,
and read back correctly — while writes that did not match the signature passed
through untouched. Its tests, which run without an exFAT volume, are in
[test/plugin.test.mjs](./test/plugin.test.mjs).

*(A minimal reproduction needs a filesystem that genuinely lacks hard links: a USB
stick formatted FAT32/exFAT, or a VHD created and formatted as exFAT in Windows
Disk Manager. `subst` does not work — it only maps a drive letter onto a directory,
so the underlying filesystem, and its hard-link support, are unchanged.)*