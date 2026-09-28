# Atomic output — design and protocol

`renderers/shared/atomic-output.mjs` is the durability layer that every
`finalize`, `deliver`, `compare`, and `migrate` operation depends on. It is
deliberately the only place in the codebase that performs `fs.linkSync` and
`fs.rename` for user-visible artifacts. Every other writer (examples, golden
tests, build scripts) uses plain `fs.writeFileSync` because their output is
not load-bearing.

## Why this exists

The CLI promises that a successful `finalize` leaves the destination in a
state any *future* invocation can verify against. That promise has two
real-world failure modes that a naive "write file then write `.meta.json`"
flow cannot satisfy:

1. **Crash mid-write.** A reader that opens the destination during the
   second after `fs.writeFileSync` opened but before it returned sees a
   zero-byte or partial file. The receipt then claims the file is complete.
2. **Concurrent writers.** Two `finalize` calls racing on the same
   destination either silently overwrite each other or end up with one
   winner and one corrupted loser. There is no audit trail of which
   process wrote what.

The atomic-output layer answers both with one protocol:

> A regular file is committed by hard-linking a candidate into the
> destination. Because the destination's inode is the candidate's inode,
> every later read can verify "this exact candidate is now at this path"
> without trusting filesystem metadata alone.

## The contract

The `captureRegularFileBinding` function returns a snapshot that records:

- `device` (the volume the entry lives on; `BigInt` for Windows correctness)
- `inode` (the entry identity; `BigInt`; never `0n` — `0` means "not yet
  allocated")
- `mode` (file mode bits; `BigInt`; the full set so `chmod` round-trips)
- `size` (current byte length)
- `sha256` (digest of the file body — only when `includeContent` is true)
- `nlink` (link count — always `1` for committed entries; the protocol
  rejects hard-linked targets because they cannot be uniquely owned)

The `verifyRegularFileBinding` function re-derives these values at any later
moment and returns `{ status: 'match' | 'mismatch', reason }`. A mismatch
means the entry at that path is no longer the one we captured; the caller
fails the operation, never silently proceeds.

The `quarantineRemoveRegularFileBinding` function moves an owned file into
a private directory (`archify-remove-*`) before deleting it, so the
deletion is recoverable if the system crashes mid-unlink. A successful
quarantine + unlink round trip is the only path that returns
`status: 'removed'`. Anything else means "the file at this path is no
longer ours; abort."

## Why hard link, not rename

`fs.renameSync` swaps the destination's directory entry to point at the
candidate. After the rename, the destination's inode is the candidate's
inode — so the verify-after-commit check works the same way.

We use `fs.linkSync` + `unlinkSync` instead because:

- `linkSync` is atomic on POSIX for hard-link creation. The destination
  becomes a hard link to the candidate in one operation.
- The candidate is then removed from its staging directory via
  `quarantineRemoveRegularFileBinding`, which preserves the destination's
  sole hard link while making the deletion recoverable.
- If the process crashes between `linkSync` and the quarantine removal,
  the candidate's link count is `2` (one in staging, one at the
  destination). The `expectedLinks: 1` check at finalize time detects
  this — the candidate still exists, but the destination is correctly
  populated. Recovery is "delete the staging leftover."

`fs.renameSync` would lose the link-count invariant: a crashed rename
either fully committed or fully rolled back, with no way to distinguish
"never started" from "completed and crashed after."

## Why `fs.constants.O_NOFOLLOW` (sometimes)

On POSIX, opening a path with `O_NOFOLLOW` rejects symlinks — opening a
symlink to a regular file would race a TOCTOU attacker who swaps the
target between our lstat and our open. On Windows, `O_NOFOLLOW` is
ignored at the syscall level, so we set `0` and rely on the handle-based
fstat to detect the swap: if the inode on the open handle does not match
the inode from the path-stat, the capture returns
`status: 'unknown', reason: 'target-changed-during-inspection'`.

## Why the quarantine for removal

`fs.unlinkSync` is atomic on POSIX but not on every networked filesystem.
SMB clients can return success before the server has fully released the
entry. The quarantine directory (named `archify-remove-<random>`) holds
the file briefly before unlinking it; if the server reports the unlink
failed after the local ack, the file remains in the quarantine with the
quarantine directory preserved, and a later recovery tool can either retry
the unlink or restore it. The protocol is:

```text
captureRegularFileBinding(path)
        ↓
  bind → { identity, content, mode, sha256, bytes }
        ↓
quarantineRemoveRegularFileBinding(bind, path)
        ↓
  rename into .archify-remove-<rand>/
        ↓
  fs.unlinkSync from .archify-remove-<rand>/
        ↓
  status: 'removed' | 'recovery-required' | 'unknown'
```

`recovery-required` returns the quarantine file path so the caller can
leave it in place and surface it to the operator.

## What fails closed

The atomic-output layer fails closed by default:

- A target whose `nlink > 1` is rejected (`hardlinked`) — we cannot
  uniquely own a multi-link file, so any unlink would surprise a sibling.
- A target whose identity is `0n` (e.g. on a Windows FAT filesystem that
  does not surface inodes) is rejected (`identity-unavailable`).
- A target that changes inode, device, mode, size, or content between
  capture and verify is rejected (`mismatch` with a specific reason).
- A target whose handle cannot be opened without following a symlink is
  rejected (`target-handle-inspection-failed`).

Every rejection returns a `{ status, reason }` shape the caller maps to a
diagnostic. No caller path is allowed to treat a rejection as success.

## What this is NOT

- This is **not** a transactional database. It does not roll back partial
  side effects on remote systems; it only guarantees the local filesystem
  state is consistent.
- This is **not** a concurrency lock. The delivery lock in
  `bin/archify.mjs` (`deliveryLockPath`) prevents two `finalize` calls
  from racing on the same destination; the atomic-output layer assumes its
  caller holds that lock and verifies the post-condition anyway.
- This is **not** idempotent across destination paths. Two `finalize`
  calls on two different destinations produce two independent artifacts;
  the layer does not deduplicate by content.

## Where to look in the source

| Function | Purpose |
|---|---|
| `captureAtomicOutput` | One-shot snapshot of a target's full identity, content, mode |
| `captureRegularFileBinding` | Reusable version; same guarantees, callable any number of times |
| `verifyAtomicOutput` | Re-derive identity for an already-captured target |
| `verifyRegularFileBinding` | Reusable version |
| `quarantineRemoveRegularFileBinding` | Move into private quarantine, then unlink |
| `backupPublicRegularFileBinding` | Move a destination aside before overwriting |
| `removeEmptyDirectoryWithRetry` | Bounded retry on SMB "ENOTEMPTY" races |

The tests under `test/atomic-output*.test.mjs`, `test/portable-delivery*.test.mjs`,
and `test/delivery-lock*.test.mjs` cover the failure-mode matrix: hardlink
detection, mode mismatches, content hash mismatches, racing claimants, and
post-commit recovery.