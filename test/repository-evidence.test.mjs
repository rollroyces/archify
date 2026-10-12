import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startPreview } from '../archify/bin/preview.mjs';
import { verifyRepositoryEvidence } from '../archify/renderers/shared/repository-evidence.mjs';
import { skillRoot, cli, git, fixture, run, evidencePayload } from './helpers/repository-evidence-fixture.mjs';

// Address variants exercise the same real Git verifier. Keep representative
// CLI paths to prove that the verified payload reaches HTML and delivery receipts,
// instead of rendering the same diagram again for every spelling of its origin.
function verifyRemoteEvidence(data, output, { cli: throughCli = false, command = 'deliver' } = {}) {
  if (!throughCli) {
    const evidence = verifyRepositoryEvidence('architecture', data.diagram, data.root);
    assert.equal(evidence.verified, true);
    return evidence;
  }
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const args = [command, 'architecture', data.input, output, '--repo-root', data.root];
  if (command === 'deliver') args.push('--json');
  const result = run(args);
  assert.equal(result.status, 0, `${data.diagram.meta.repository.url}: ${result.stderr || result.stdout}`);
  const html = fs.readFileSync(output, 'utf8');
  const evidence = evidencePayload(html);
  assert.equal(evidence.verified, true);
  assert.doesNotMatch(html, /SYNTHETIC_TOKEN|not-a-real-token/);
  if (command === 'deliver') {
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.evidence.verified, true);
    assert.equal(receipt.evidence.linkMode, evidence.repository.linkMode);
  }
  return evidence;
}

test('evidence reports independent source problems in authored order', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.diagram.components[0].sources = [{ path: 'src/missing.js' }, { path: '../escape' }];
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const result = run(['validate', 'architecture', data.input, '--repo-root', data.root, '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.diagnostics.map(({ code, subject }) => [code, subject.path]), [
    ['repository-evidence/file-missing', '/components/0/sources/0/path'],
    ['repository-evidence/path-escape', '/components/0/sources/1/path'],
  ]);
});

test('delivery reports all invalid source ranges for one repair and preserves the previous artifact', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.diagram.components[0].sources = [{ path: 'src/router.js', line: 1, end_line: 99 }];
  data.diagram.components[1].sources = [{ path: 'src/store.js', line: 1, end_line: 9 }];
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const output = path.join(data.root, 'trusted.html');
  fs.writeFileSync(output, 'trusted previous artifact');
  const args = ['deliver', 'architecture', data.input, output, '--repo-root', data.root, '--json'];
  const failed = run(args);
  assert.equal(failed.status, 1);
  const report = JSON.parse(failed.stdout);
  assert.deepEqual(report.diagnostics.map(({ code, subject, evidence }) =>
    [code, subject.path, evidence.requestedLine, evidence.lineCount]), [
    ['repository-evidence/line-out-of-range', '/components/0/sources/0', 99, 3],
    ['repository-evidence/line-out-of-range', '/components/1/sources/0', 9, 1],
  ]);
  assert.equal(fs.readFileSync(output, 'utf8'), 'trusted previous artifact');

  // Both corrections are available from one failed call; no source is removed.
  data.diagram.components[0].sources[0].end_line = report.diagnostics[0].evidence.lineCount;
  data.diagram.components[1].sources[0].end_line = report.diagnostics[1].evidence.lineCount;
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const repaired = run(args);
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).evidence.references, 2);
  assert.equal(evidencePayload(fs.readFileSync(output, 'utf8')).referenceCount, 2);
});

test('path-only evidence verifies types without reading blob contents', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.diagram.components[0].sources = [{ path: 'src/router.js' }, { path: 'src/store.js' }];
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const trace = path.join(data.root, 'git.trace');
  const result = spawnSync(process.execPath, [cli, 'validate', 'architecture', data.input, '--repo-root', data.root, '--json'], {
    cwd: skillRoot, encoding: 'utf8', env: { ...process.env, GIT_TRACE: trace },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(fs.readFileSync(trace, 'utf8'), /cat-file --batch(?:\s|$)|\bshow\s/);
});

test('line evidence retains the per-file read limit after batch prefetch', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.root, 'large.txt'), Buffer.alloc(17 * 1024 * 1024, 'x'));
  git(data.root, 'add', 'large.txt');
  git(data.root, 'commit', '-m', 'large source');
  data.diagram.meta.repository.revision = git(data.root, 'rev-parse', 'HEAD');
  data.diagram.components[0].sources = [
    { path: 'src/router.js', line: 99 },
    { path: 'large.txt', line: 1 },
    { path: 'src/store.js', line: 99 },
  ];
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const result = run(['validate', 'architecture', data.input, '--repo-root', data.root, '--json']);
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics.map(({ code }) => code), [
    'repository-evidence/line-out-of-range',
    'repository-evidence/git-unavailable',
  ], 'preserve earlier errors but stop at the read limit instead of checking later citations');
});

test('repository root accepts a different spelling of the same physical Git top-level', (t) => {
  const data = fixture();
  const alias = `${data.root}-alias`;
  fs.symlinkSync(data.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));

  // Windows APIs and Git can report the same directory with different case or
  // long/short spellings. Preserve the authored alias for the first lookup so
  // this test exercises physical identity instead of string equality.
  const realpathSync = fs.realpathSync;
  let preservedAlias = false;
  t.mock.method(fs, 'realpathSync', (target, ...args) => {
    if (!preservedAlias && path.resolve(String(target)) === path.resolve(alias)) {
      preservedAlias = true;
      return alias;
    }
    return Reflect.apply(realpathSync, fs, [target, ...args]);
  });

  const evidence = verifyRepositoryEvidence('architecture', data.diagram, alias);
  assert.equal(preservedAlias, true);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.repository.revision, data.revision);
});

test('repository root rejects a different physical directory inside the repository', () => {
  const data = fixture();
  assert.throws(
    () => verifyRepositoryEvidence('architecture', data.diagram, path.join(data.root, 'src')),
    (error) => error?.archifyDiagnostics?.some(({ code }) => code === 'repository-evidence/root-not-top-level'),
  );
});

test('repository url carrying a local path names the origin-discovery fix', () => {
  const data = fixture();
  data.diagram.meta.repository.url = data.root;
  assert.throws(
    () => verifyRepositoryEvidence('architecture', data.diagram, data.root),
    (error) => {
      const diagnostic = error?.archifyDiagnostics?.find(({ code }) => code === 'repository-evidence/url-invalid');
      assert.ok(diagnostic);
      assert.equal(diagnostic.evidence.authoredValueLooksLike, 'local filesystem path; the expected value is the remote origin address');
      assert.ok(diagnostic.supportedFixes.some((fix) => fix.includes('git remote get-url origin')));
      assert.equal(JSON.stringify(diagnostic).includes(data.root), false, 'the authored value must not be echoed into diagnostics');
      return true;
    },
  );

  data.diagram.meta.repository.url = 'not a url at all';
  assert.throws(
    () => verifyRepositoryEvidence('architecture', data.diagram, data.root),
    (error) => {
      const diagnostic = error?.archifyDiagnostics?.find(({ code }) => code === 'repository-evidence/url-invalid');
      assert.ok(diagnostic);
      assert.equal(diagnostic.evidence.authoredValueLooksLike, undefined);
      return true;
    },
  );
});

test('repository URL diagnostics identify Windows local paths without echoing them', () => {
  const data = fixture();
  for (const localPath of [String.raw`\\server\share\repo`, String.raw`C:\work\repo`, String.raw`.\repo`, String.raw`..\repo`]) {
    data.diagram.meta.repository.url = localPath;
    assert.throws(
      () => verifyRepositoryEvidence('architecture', data.diagram, data.root),
      (error) => {
        const diagnostic = error?.archifyDiagnostics?.find(({ code }) => code === 'repository-evidence/url-invalid');
        assert.ok(diagnostic);
        assert.match(diagnostic.evidence.authoredValueLooksLike, /local filesystem path/);
        assert.ok(diagnostic.supportedFixes.some((fix) => fix.includes('git remote get-url origin')));
        assert.equal(JSON.stringify(diagnostic).includes(JSON.stringify(localPath).slice(1, -1)), false);
        return true;
      },
    );
  }
});

test('repository root fails closed when physical identity is indeterminate', (t) => {
  const data = fixture();
  const inaccessible = Object.assign(new Error('synthetic identity failure'), { code: 'EACCES' });
  t.mock.method(fs, 'statSync', () => { throw inaccessible; });

  assert.throws(
    () => verifyRepositoryEvidence('architecture', data.diagram, data.root),
    (error) => {
      const diagnostic = error?.archifyDiagnostics?.find(
        ({ code }) => code === 'repository-evidence/root-identity-indeterminate',
      );
      assert.ok(diagnostic);
      assert.equal(diagnostic.evidence.relation.code, 'root-resolution-failed');
      assert.equal(diagnostic.evidence.relation.systemCode, 'EACCES');
      return true;
    },
  );
});

test('Gitee evidence generates provider-specific revision and line links', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  data.diagram.meta.repository.url = 'https://gitee.com/example/evidence-repo';
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const output = path.join(data.root, 'gitee.html');
  for (const [index, remote] of [
    'https://gitee.com/example/evidence-repo.git/',
    'git@gitee.com:example/evidence-repo.git',
    'ssh://git@gitee.com/example/evidence-repo.git',
  ].entries()) {
    git(data.root, 'remote', 'set-url', 'origin', remote);
    const evidence = verifyRemoteEvidence(data, output, { cli: index === 0 });
    assert.equal(evidence.repository.href, `https://gitee.com/example/evidence-repo/tree/${data.revision}`);
    assert.equal(evidence.nodes.users[0].href, `https://gitee.com/example/evidence-repo/blob/${data.revision}/src/router.js#L1-3`);
    assert.equal(evidence.nodes.users[1].href, `https://gitee.com/example/evidence-repo/blob/${data.revision}/src/store.js#L1`);
  }
});
