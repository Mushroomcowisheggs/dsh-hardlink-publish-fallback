# Defect report: `write` can never create a new file on volumes without hard-link support

## Summary

`writeFileAtomic` in `@deepseek-ai/dsh-fs-local` publishes a **new** file by
hard-linking the staged temp file onto the target. On a volume whose filesystem
has no hard links (exFAT, FAT32, some SMB shares), Windows rejects that call with
**`EISDIR`**, the guarded-create handler does not recognize the code, and the error
is rethrown as a generic `FS_IO_ERROR`.

The write intent is `createIfAbsent`. Because the intent's publication primitive
is the only thing that can satisfy it, and that primitive fails unconditionally on
such a volume, **every attempt to create a new file fails permanently**. Updating
an existing file keeps working, because that path publishes with
`ReplaceFileW`/`rename` instead. The result is a half-broken tool: edits succeed,
creation never does.

## Environment

| | |
|---|---|
| OS | Windows 11 (NTFS 10.0.26100.0) |
| Node | v22.20.0 |
| `dsh` | 0.1.5-rc.1 |
| `@deepseek-ai/dsh-fs-local` | 0.1.5-rc.2 |
| Workspace volume | a volume formatted exFAT (any non-hard-link filesystem reproduces it) |
| Surface | Web profile, `standard`/`cordis` agent preset, default `workspace-write` sandbox |

## Impact

- The `write` tool cannot create a new file anywhere under a workspace on such a
  volume. Every task that produces a file is blocked.
- Updates to existing files, and `edit`, are unaffected — which makes the symptom
  look intermittent rather than like a hard capability loss.
- Not volume-optional from the user's perspective: pointing a workspace at a
  removable/`exFAT` drive is a normal thing to do.

## Reproduction

On a volume without hard-link support:

```
write  file_path = <workspace>\new.txt   content = "x"
→ Error: cannot write "<workspace>\new.txt": EISDIR: illegal operation on a directory,
    link '<workspace>\.new.txt.<pid>.<uuid>.tmpdir\new.txt.tmp' -> '<workspace>\new.txt'
```

The same call against an existing file succeeds (`Updated file`), and `edit`
succeeds. The staging directory is cleaned up correctly, so the volume is left
clean; nothing is half-written.

### Isolation of the primitive

```js
// On the exFAT volume, with an existing staged file `temp`:
fs.linkSync(temp, target)     // → code=EISDIR  errno=-4068  syscall=link
fs.renameSync(temp, target)   // → OK
```

`mkdir` of the staging directory, `open(tempPath, 'wx')`, `writeFile`, `chmod`,
and `sync` all succeed. **Only the linking publication fails.**

## Root cause

`packages/fs/fs-local/src/fsio.ts`, `writeFileAtomic` (shipped at
`node_modules/@deepseek-ai/dsh-fs-local/lib/index.js:494`). The guarded-create arm:

```js
// lib/index.js:532-536
if (createIfAbsent !== void 0) try {
    await linkFile(tempPath, absolutePath);            // ← :533, fails EISDIR here
} catch (error) {
    await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
}
```

```js
// lib/index.js:465-478, condensed
async function throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget) {
    let existing;
    try { existing = await inspectPublicationTarget(absolutePath); }
    catch (metadataError) {
        if (!isENOENT(metadataError) && !isENOTDIR(metadataError))
            throw new FsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, "FS_IO_ERROR", …);
    }
    if (existing !== void 0) {
        if (!existing.isFile()) throw new FsError(…, "FS_NOT_REGULAR_FILE", …);
        throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, "FS_NOT_OBSERVED", …);
    }
    if (isEEXIST(error)) throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, "FS_NOT_OBSERVED", …);
    throw new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, "FS_IO_ERROR", …);  // ← :477
}
```

The handler interprets a failing `link()` in exactly two ways: contention
(`EEXIST` → `FS_NOT_OBSERVED`) or an unexplained I/O fault (everything else →
`FS_IO_ERROR`). `EISDIR` carries no contention meaning, so the raw Node message
escapes to the model and the operation is abandoned.

Two related observations:

1. **The `rename` fallback for the create arm is unreachable.** Unlike the replace
   arm (`:537-542`), which falls back to `rename` when `ReplaceFileW` reports
   `ENOENT`, the create arm has no fallback at all. Even if it did, gating it on
   `isENOENT` would not help: `mkdir(directory, { recursive: true })` at `:497`
   runs first, so the parent always exists and the `EISDIR` is what comes back.
2. **The sibling implementation does not have this defect.**
   `packages/fs/atomic-write` (`@deepseek-ai/dsh-atomic-write`,
   `lib/index.js:60-76`) publishes with `writeFile(temp, …, { flag: 'wx' })` plus
   `renameAtomicTemp`; it never hard-links for this guard and is therefore already
   compatible with hard-link-less volumes. The two publication implementations in
   the tree disagree on this point.

## Proposed fix

Treat `EISDIR`/`ENOTSUP`/`EOPNOTSUPP` from the link attempt as "this volume cannot
link", not as a user-visible I/O fault, and publish with an atomic no-clobber
primitive that does not need hard links. With `node:fs/promises`, an exclusive
copy is the closest equivalent:

```js
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";

const LINK_UNSUPPORTED = new Set(["EISDIR", "ENOTSUP", "EOPNOTSUPP"]);

if (createIfAbsent !== void 0) try {
    await linkFile(tempPath, absolutePath);
} catch (error) {
    if (LINK_UNSUPPORTED.has(error?.code ?? "")) {
        // This volume cannot hard-link: publish with an exclusive copy, which
        // keeps the same no-clobber guarantee (EEXIST on a racing creator).
        try {
            await copyFile(tempPath, absolutePath, constants.COPYFILE_EXCL);
        } catch (copyError) {
            await throwGuardedCreateFailure(copyError, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
        }
    } else {
        await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);
    }
}
```

Notes on the sketch:

- `COPYFILE_EXCL` maps a racing creator to `EEXIST`, which
  `throwGuardedCreateFailure` already handles, so the guard's semantics are
  preserved exactly.
- The copy is not a link, so the two inodes are independent; that is already true
  of the rename-based replace path, and nothing in the contract requires the
  published file to share an inode with the staging file.
- If inode sharing is load-bearing, the alternative is a `rename` fallback gated
  on "target still absent at publication time". The static lstat already used by
  `inspectPublicationTarget` narrows that to the same TOCTOU window the module
  documents and accepts elsewhere.
- Whichever primitive is chosen, the diagnostic in `throwGuardedCreateFailure` is
  worth broadening: `EISDIR` from `link()` is a capability signal, so it should
  never surface as `FS_IO_ERROR`.

## Workaround available today

`dsh-hardlink-publish-fallback` detects the failure signature and completes the
operation through the rename path. It is a runtime patch for an upstream defect
and should be retired once the fix lands. It is distributed as a GitHub project
carrying the `dsh-plugin` topic, which `CONTRIBUTING.md` names as the discovery
mechanism for community plugins.

## Verification after the fix

- `write` creates a new file on an `exFAT` (or other hard-link-less) volume.
- `write` still refuses to clobber a file that was created concurrently:
  `EEXIST` → `FS_NOT_OBSERVED`.
- The read-before-write guard is unchanged: a second `write` to a file that was
  created but never read still reports `FS_NOT_OBSERVED`.
- A normal NTFS volume still publishes via the hard-link path (or the copy path —
  either satisfies the contract), and `dsh-atomic-write`'s behavior is unaffected.
