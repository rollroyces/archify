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
test('Codeberg evidence emits /src/commit/ links for HTTPS and SSH origins with case-preserving paths', () => {
  const data = fixture();
  data.diagram.meta.repository.url = 'https://codeberg.org/Forgejo/Forgejo';
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const output = path.join(data.root, 'codeberg.html');
  for (const remote of [
    'https://codeberg.org/Forgejo/Forgejo.git/',
    'git@codeberg.org:Forgejo/Forgejo.git',
    'ssh://git@codeberg.org/Forgejo/Forgejo.git',
  ]) {
    git(data.root, 'remote', 'set-url', 'origin', remote);
    const result = run(['deliver', 'architecture', data.input, output, '--repo-root', data.root, '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = evidencePayload(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.repository.href, `https://codeberg.org/Forgejo/Forgejo/src/commit/${data.revision}`);
    assert.equal(evidence.nodes.users[0].href, `https://codeberg.org/Forgejo/Forgejo/src/commit/${data.revision}/src/router.js#L1-L3`);
    assert.equal(evidence.nodes.users[1].href, `https://codeberg.org/Forgejo/Forgejo/src/commit/${data.revision}/src/store.js#L1`);
  }
});

test('public gitea.com evidence emits /src/commit/ links for HTTPS and SSH origins with case-preserving paths', () => {
  const data = fixture();
  data.diagram.meta.repository.url = 'https://gitea.com/gitea/Tea';
  fs.writeFileSync(data.input, JSON.stringify(data.diagram));
  const output = path.join(data.root, 'gitea-com.html');
  for (const remote of [
    'https://gitea.com/gitea/Tea.git/',
    'git@gitea.com:gitea/Tea.git',
    'ssh://git@gitea.com/gitea/Tea.git',
  ]) {
    git(data.root, 'remote', 'set-url', 'origin', remote);
    const result = run(['deliver', 'architecture', data.input, output, '--repo-root', data.root, '--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = evidencePayload(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.repository.href, `https://gitea.com/gitea/Tea/src/commit/${data.revision}`);
    assert.equal(evidence.nodes.users[0].href, `https://gitea.com/gitea/Tea/src/commit/${data.revision}/src/router.js#L1-L3`);
    assert.equal(evidence.nodes.users[1].href, `https://gitea.com/gitea/Tea/src/commit/${data.revision}/src/store.js#L1`);
  }
});

test('parseRepositoryRemote recognises canonical HTTPS, Git SSH, and SCP forms for codeberg.org and gitea.com', () => {
  const codebergHttps = parseRepositoryRemote('https://codeberg.org/forgejo/forgejo.git');
  assert.equal(codebergHttps.provider, 'codeberg');
  assert.equal(codebergHttps.protocol, 'https:');
  assert.equal(codebergHttps.endpoint, 'standard');
  assert.equal(codebergHttps.path, 'forgejo/forgejo');
  // Identity is hostname, port-equivalent endpoint, pathKind, and the
  // raw (case-preserving) repository path.
  assert.equal(codebergHttps.identity, JSON.stringify(['codeberg.org', 'standard', 'repository', 'forgejo/forgejo']));

  const codebergSsh = parseRepositoryRemote('git@codeberg.org:Forgejo/Forgejo.git');
  assert.equal(codebergSsh.provider, 'codeberg');
  assert.equal(codebergSsh.protocol, 'ssh:');
  assert.equal(codebergSsh.endpoint, 'standard');
  assert.equal(codebergSsh.path, 'Forgejo/Forgejo');
  assert.equal(codebergSsh.identity, JSON.stringify(['codeberg.org', 'standard', 'repository', 'Forgejo/Forgejo']));

  const giteaHttps = parseRepositoryRemote('https://gitea.com/gitea/tea.git');
  assert.equal(giteaHttps.provider, 'gitea');
  assert.equal(giteaHttps.protocol, 'https:');
  assert.equal(giteaHttps.endpoint, 'standard');
  assert.equal(giteaHttps.path, 'gitea/tea');

  const giteaSsh = parseRepositoryRemote('git@gitea.com:gitea/Tea.git');
  assert.equal(giteaSsh.provider, 'gitea');
  assert.equal(giteaSsh.protocol, 'ssh:');
  assert.equal(giteaSsh.endpoint, 'standard');
  assert.equal(giteaSsh.path, 'gitea/Tea');
});

test('repositorySourceHref emits /src/commit/ URLs for codeberg and gitea, including encoded paths and line ranges', () => {
  const sha = '0380b6d688eaf1390e4f24c618386737bf9fc6b1';
  // The acceptance samples from issues #866 and #864.
  assert.equal(
    repositorySourceHref('codeberg', 'https://codeberg.org/forgejo/forgejo', sha, { path: 'README.md', line: 1, endLine: 3 }),
    `https://codeberg.org/forgejo/forgejo/src/commit/${sha}/README.md#L1-L3`,
  );
  assert.equal(
    repositorySourceHref('gitea', 'https://gitea.com/gitea/tea', sha, { path: 'README.md', line: 1, endLine: 3 }),
    `https://gitea.com/gitea/tea/src/commit/${sha}/README.md#L1-L3`,
  );
  // Single-line path-only references stay on /src/commit/.
  assert.equal(
    repositorySourceHref('codeberg', 'https://codeberg.org/forgejo/forgejo', sha, { path: 'src/router.js', line: 1 }),
    `https://codeberg.org/forgejo/forgejo/src/commit/${sha}/src/router.js#L1`,
  );
  // Path-only sources emit no fragment.
  assert.equal(
    repositorySourceHref('codeberg', 'https://codeberg.org/forgejo/forgejo', sha, { path: 'README.md' }),
    `https://codeberg.org/forgejo/forgejo/src/commit/${sha}/README.md`,
  );
  // Non-ASCII paths are percent-encoded exactly like Gitee.
  assert.equal(
    repositorySourceHref('codeberg', 'https://codeberg.org/Forgejo/Forgejo', sha, { path: 'src/中文 # router.js', line: 1, endLine: 2 }),
    `https://codeberg.org/Forgejo/Forgejo/src/commit/${sha}/src/${encodeURIComponent('中文 # router.js')}#L1-L2`,
  );
  // Root revision links (/src/commit/<sha>) mirror the source-link prefix.
  assert.equal(
    repositoryRootHref('codeberg', 'https://codeberg.org/forgejo/forgejo', sha),
    `https://codeberg.org/forgejo/forgejo/src/commit/${sha}`,
  );
  assert.equal(
    repositoryRootHref('gitea', 'https://gitea.com/gitea/tea', sha),
    `https://gitea.com/gitea/tea/src/commit/${sha}`,
  );
});

test('self-hosted Forgejo and Gitea remain local-only (provider stays null)', () => {
  for (const url of [
    'https://git.example.com/owner/repo.git',
    'https://gitea.internal.example/owner/repo.git',
    'https://forgejo.acme.test:8443/Platform/repo.git',
    'git@git.example.com:owner/repo.git',
  ]) {
    const parsed = parseRepositoryRemote(url);
    assert.notEqual(parsed, null, url);
    assert.equal(parsed.provider, null, `${url} must not declare a public provider`);
  }

  const data = fixture();
  for (const [url, remote] of [
    ['https://git.example.com/Platform/evidence-repo', 'https://git.example.com/Platform/evidence-repo'],
    ['https://gitea.internal.example/Platform/evidence-repo', 'https://gitea.internal.example/Platform/evidence-repo'],
  ]) {
    data.diagram.meta.repository = { url, revision: data.revision, link_mode: 'local-only' };
    fs.writeFileSync(data.input, JSON.stringify(data.diagram));
    git(data.root, 'remote', 'set-url', 'origin', remote);
    const output = path.join(data.root, 'self-hosted.html');
    const result = run(['deliver', 'architecture', data.input, output, '--repo-root', data.root, '--json']);
    assert.equal(result.status, 0, `${url}: ${result.stderr || result.stdout}`);
    const evidence = evidencePayload(fs.readFileSync(output, 'utf8'));
    assert.equal(evidence.repository.linkMode, 'local-only');
    assert.equal(evidence.repository.href, undefined);
    assert.ok(evidence.nodes.users.every((source) => !Object.hasOwn(source, 'href')));
  }
});

test('Codeberg and gitea.com rejecting non-standard endpoints still routes web mode to local-only', () => {
  const data = fixture();
  for (const repository of [
    { url: 'https://codeberg.org:8443/forgejo/forgejo.git', remote: 'https://codeberg.org:8443/forgejo/forgejo.git' },
    { url: 'http://codeberg.org/forgejo/forgejo.git', remote: 'http://codeberg.org/forgejo/forgejo.git' },
    { url: 'ssh://git@codeberg.org:2222/forgejo/forgejo.git', remote: 'ssh://git@codeberg.org:2222/forgejo/forgejo.git' },
    { url: 'https://gitea.com:8443/gitea/tea.git', remote: 'https://gitea.com:8443/gitea/tea.git' },
  ]) {
    data.diagram.meta.repository = { url: repository.url, revision: data.revision };
    fs.writeFileSync(data.input, JSON.stringify(data.diagram));
    git(data.root, 'remote', 'set-url', 'origin', repository.remote);
    const result = run(['validate', 'architecture', data.input, '--repo-root', data.root, '--json']);
    assert.equal(result.status, 1, repository.url);
    assert.ok(
      JSON.parse(result.stdout).diagnostics.some(({ code }) => code === 'repository-evidence/links-unsupported'),
      repository.url,
    );
  }
});
