# Prior reports of this defect

This defect has been reported repeatedly. The threads below predate this repository
and are where the analysis lives; `CONTRIBUTING.md` states that upvotes on a
discussion are how reports are brought to the team's attention.

| Discussion | Title as indexed |
|---|---|
| [#5704](https://github.com/deepseek-ai/deepseek-harness/discussions/5704) | `write tool fails on exFAT volumes with misleading EISDIR error (Windows)` |
| [#5127](https://github.com/deepseek-ai/deepseek-harness/discussions/5127) | `write tool cannot create new files on exFAT volumes (Windows): EISDIR from hard-link no-replace publication` |
| [#4981](https://github.com/deepseek-ai/deepseek-harness/discussions/4981) | `write: new-file publish uses a hard link, so it fails on exFAT (EISDIR) with no fallback` |
| [#3919](https://github.com/deepseek-ai/deepseek-harness/discussions/3919) | `write/edit tools fail on Google Drive Desktop virtual filesystem (Windows): SetFileSecurityW Win32 87 and link EISDIR` |
| [#3884](https://github.com/deepseek-ai/deepseek-harness/discussions/3884) | `fs writeFileAtomic: no-replace publish fails on exFAT/FAT32 (hard links unsupported)` |

## The state of these threads (as pasted by the maintainer of this repository)

- **#3884 is the AUTHORITATIVE report.** #5127 was closed by its own author as a
  duplicate of #3884, with the note that #3884 carries "the exFAT/FAT32 + network
  mounts, EISDIR error mapping, TOCTOU trade-off, working ~40-line patch".
- **#5704 is the active open thread.** It is not a duplicate report but a
  three-participant working thread. It already contains:
  - item-by-item source verification of the root cause, with anchors
    (`fsio.ts:546/580` staging + `linkFile`, `:44-46` verbatim `errorMessage`
    passthrough, `:543` unconditional `mkdir(dirname, { recursive: true })`);
  - the determination that `EISDIR` originates in **Node/libuv**, not in dsh —
    libuv mis-maps the failed `link()` on exFAT; the true error is WinError 1
    (`ERROR_INVALID_FUNCTION`), and this was filed upstream as **nodejs/node#65817**;
  - **two reference diffs**: (A) tolerate `mkdir` `EPERM` when the parent already
    exists (drive root), and (B) degrade `link` failure to `rename` when the
    target is still absent;
  - an injected unit-test sketch for the fallback.
- A later participant re-verified on master `c291e7961` that **neither fix is
  merged**; both behaviours are still present.
- The thread decomposes the problem into **two independent defects**, which is
  the most useful framing to come out of it:
  - **A — drive-root `mkdir` `EPERM`**: cross-filesystem (reproduced on all five
    letters, NTFS and exFAT alike). Blocks *any* write to a drive root.
  - **B — exFAT hard-link publication**: only on hard-link-less volumes. Blocks
    creating a new file.

## What this means for the material in this repository

The threads above already carry the root cause, the 	hrowGuardedCreateFailure chain, the EISDIR-from-libuv finding, and reference diffs — in more detail than any later restatement could add. Read them first; treat the material in this repository as corroboration on real hardware rather than as a new finding.

- `POST.md` was written **without** deduplicating against those threads. It is
  therefore likely to repeat analysis they already contain: at least one thread
  is indexed with a code excerpt from `throwGuardedCreateFailure`, so the root
  cause is probably already documented there, and possibly a patch as well.
- Treat `POST.md` as **candidate supplementary evidence** — a minimal
  reproduction, the `linkSync` vs `renameSync` isolation, and the `COPYFILE_EXCL`
  sketch — not as a report to file verbatim.
- The plugin itself is unaffected by any of this: it works against the shipped
  behavior regardless of whether the underlying defect is known, fixed, or
  disputed.

## How this list was produced, and its limit

The list comes from search-engine indexes. In the environment where this was
written, `github.com` resolves to a non-public address, so neither the discussion
bodies nor their comments could be read directly. The titles above are as indexed,
and the completeness of the list has not been verified against GitHub itself. The
live search is the authority:

https://github.com/deepseek-ai/deepseek-harness/discussions?discussions_q=is%3Aopen+hard-link