# exFAT volume: hard-link publication fails, rename fallback verified

`write` cannot create a new file on a volume whose filesystem has no hard links —
exFAT, FAT32, some network shares — while updating an existing file and `edit`
continue to work. The defect and its root cause are covered in #3884 and #5704
(`EISDIR` originates in Node/libuv; upstream: nodejs/node#65817).

This is what a fixed (non-removable) exFAT volume actually does.

| | |
|---|---|
| OS | Windows 11 (10.0.26100.0) |
| Node | v22.20.0 |
| `dsh` | 0.1.5-rc.1 |
| `@deepseek-ai/dsh-fs-local` | 0.1.5-rc.2 |
| Volume | a volume formatted exFAT, fixed rather than removable |

The failure tracks the filesystem, not whether the drive is a USB device.

## The failure

```
cannot write "<workspace>\<file>": EISDIR: illegal operation on a directory,
  link '<workspace>\.<file>.<pid>.<uuid>.tmpdir\<file>.tmp' -> '<workspace>\<file>'
```

Deterministic for every new file, in the workspace root and in subdirectories
alike. Overwriting an existing file reports `Updated file`, and `edit` succeeds.

## The primitives

With the staged temp file already written, against the same target path, in one run:

```js
fs.linkSync(temp, target)     // → code=EISDIR  errno=-4068  syscall=link
fs.renameSync(temp, target)   // → OK, content reads back correctly
```

`mkdir` of the staging directory, `open(tempPath, 'wx')`, `writeFile`, `chmod` and
`sync` all succeed in the same run. `fs.renameSync` equally succeeds into a
subdirectory that had to be created first.

## Falling back to rename

Attempting the link, and degrading to `rename` only while the target is still
absent, behaves as intended on this volume — one case per row:

| Case | Result |
|---|---|
| New file, target absent | falls back to `rename`; file published; content correct |
| Concurrent creator, target already present | **no** fallback; the original failure is raised and the existing content survives byte-for-byte |
| Staging file after a successful fallback | consumed by the publication; no residue |

The collision path is deliberately outside the fallback: `EEXIST` is not a
hard-link-unsupported signal, so a genuine race still reports contention rather
than overwriting.

## NTFS

On an NTFS volume the same call succeeds and the two paths **share an inode** — a
real hard link, not a copy. The existing create-if-absent publication therefore
behaves as before on NTFS, and the fallback never engages there.

## Drive roots fail independently of the filesystem

`writeFileAtomic` begins with `mkdir(dirname(target), { recursive: true })`. On
Windows a drive root already exists, but `mkdir` reports it as `EPERM`, and
`recursive: true` tolerates only `EEXIST`:

```js
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir  (exFAT root)
fs.mkdirSync(driveRoot, { recursive: true })  // → code=EPERM  syscall=mkdir  (NTFS root)
```

Not a hard-link problem and not exFAT-specific — it reproduces on both filesystems,
so it blocks writing a new file directly at a drive root on any Windows volume. It
also propagates into any workaround that completes the write through the same
service, because that `mkdir` runs there too.

## Other capabilities of the volume

`fs.symlinkSync` also fails with `EISDIR`. A `DSH_HOME` placed on such a volume
cannot boot: `dsh-app-boot`'s `healProfilesModuleFallback` symlinks the install into
the profile during composition.