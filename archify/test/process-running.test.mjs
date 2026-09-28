import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isProcessRunning } from '../renderers/shared/process-running.mjs';

// Live PID: fork a sleeping child and confirm we correctly report it as running.
test('process-running: a live PID from a freshly forked child is reported as running', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    assert.equal(isProcessRunning(child.pid), true, `expected PID ${child.pid} to be reported as running`);
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  }
});

// After kill, the PID must be reported as not running.
test('process-running: a forked PID is reported as not running after SIGKILL', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const pid = child.pid;
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(isProcessRunning(pid), false, `expected PID ${pid} to be reported as not running after kill`);
});

// Boundary contract: invalid inputs must always return false, never throw.
// Defensive: callers may hand us a NaN, undefined, string, or array if the
// lock receipt was tampered with. We must fail closed (return false → "stale
// lock" → recovery path) instead of throwing.
test('process-running: invalid PIDs return false without throwing', () => {
  for (const bad of [0, -1, NaN, 1.5, Infinity, -Infinity, null, undefined, '123', {}, []]) {
    assert.equal(isProcessRunning(bad), false, `expected isProcessRunning(${JSON.stringify(bad)}) === false`);
  }
});

// Cross-platform contract: a process we cannot signal because we don't own it
// must be reported as "not running" so the delivery protocol fails closed into
// the stale-lock recovery path. The previous implementation returned true for
// any error code other than ESRCH (including EPERM), which made POSIX report
// foreign PIDs as live — fine for our spawned-PID-only use case, but the
// audit's finding S3 asked us to make the semantics explicit and platform-aware
// rather than relying on POSIX assumptions.
test('process-running: EPERM from process.kill is treated as not running', () => {
  const original = process.kill;
  try {
    process.kill = function mockedKill(pid, signal) {
      if (signal === 0 && pid === 999_999_999) {
        const error = new Error('operation not permitted');
        error.code = 'EPERM';
        throw error;
      }
      return original.call(this, pid, signal);
    };
    assert.equal(isProcessRunning(999_999_999), false);
  } finally {
    process.kill = original;
  }
});

// Cross-platform contract: an ESRCH error from process.kill (the canonical
// "PID does not exist" answer on both POSIX and Windows) must always be
// treated as not running. This is the common-case path the delivery protocol
// depends on.
test('process-running: ESRCH from process.kill is treated as not running', () => {
  const original = process.kill;
  try {
    process.kill = function mockedKill(pid, signal) {
      if (signal === 0 && pid === 999_999_998) {
        const error = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
      return original.call(this, pid, signal);
    };
    assert.equal(isProcessRunning(999_999_998), false);
  } finally {
    process.kill = original;
  }
});

// No unexpected side-effects: isProcessRunning must not actually send a signal.
// We assert that by mocking process.kill and confirming we never call it with
// signal !== 0 for any input we feed the function.
test('process-running: never sends a real signal', () => {
  const original = process.kill;
  try {
    const sent = [];
    process.kill = function mockedKill(pid, signal) {
      sent.push({ pid, signal });
      // Pretend success for liveness (signal 0 path).
      return true;
    };
    isProcessRunning(12345);
    isProcessRunning(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(sent, [
      { pid: 12345, signal: 0 },
      { pid: Number.MAX_SAFE_INTEGER, signal: 0 },
    ]);
  } finally {
    process.kill = original;
  }
});