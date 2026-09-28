// Cross-platform PID liveness check used by the delivery-lock protocol.
//
// `process.kill(pid, 0)` is a permission probe, not a liveness probe. It
// succeeds silently when the caller has permission to signal the PID, even
// if no such PID exists on some POSIX kernels, and throws an error code
// otherwise:
//
//   ESRCH — no such process (canonical "PID does not exist")
//   EPERM — process exists but we cannot signal it (we do not own it)
//
// For the delivery lock we care about one question: "is the process whose
// PID is in the lock file still around and owned by us?" The only process we
// ever write into a lock receipt is one we ourselves spawned (the CLI's
// child PID), so any non-zero exit path means "the lock is stale; report it
// as not running." That keeps the protocol fail-closed: a process we cannot
// observe is treated as a stale lock, never as a live owner.
//
// This is the audit finding S3 contract.

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}