import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { discoverCodexRoot, insideRoot } from '../src/source-root.js';
import { scanCodex, prepareSession } from '../src/core.js';
const { join, resolve } = nodePath;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'source-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), external = join(base, 'external-codex');
  await mkdir(home);
  await mkdir(join(external, 'sessions'), { recursive: true });
  return { base, home, external };
}
const jsonl = records => records.map(JSON.stringify).join('\n') + '\n';
const session = id => jsonl([
  { type: 'session_meta', payload: { id, cwd: '/synthetic' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'synthetic question' }] } }
]);

test('manual is normalized and takes priority over environment and default', async t => {
  const f = await fixture(t);
  await mkdir(join(f.home, '.codex', 'sessions'), { recursive: true });
  const result = await discoverCodexRoot({ manual: '  ' + join(f.external, 'sessions', '..') + '  ', home: f.home, env: { CODEX_HOME: join(f.home, '.codex') } });
  assert.deepEqual(result, { found: true, path: resolve(f.external), source: 'manual' });
});

test('invalid explicit manual never silently falls back', async t => {
  const f = await fixture(t);
  const file = join(f.base, 'file'); await writeFile(file, 'not a directory');
  const empty = join(f.base, 'empty'); await mkdir(empty);
  await writeFile(join(empty, 'sessions'), 'not a directory');
  for (const manual of ['relative/path', join(f.base, 'missing'), file, empty]) {
    await assert.rejects(discoverCodexRoot({ manual, home: f.home, env: { CODEX_HOME: f.external } }), { code: 'INVALID_CODEX_HOME' });
  }
});

test('environment wins without manual; invalid automatic candidate falls back to default', async t => {
  const f = await fixture(t);
  const fallback = join(f.home, '.codex'); await mkdir(join(fallback, 'archived_sessions'), { recursive: true });
  assert.deepEqual(await discoverCodexRoot({ manual: ' ', home: f.home, env: { CODEX_HOME: f.external } }), { found: true, path: resolve(f.external), source: 'environment' });
  for (const CODEX_HOME of ['relative', join(f.base, 'missing'), '']) {
    assert.deepEqual(await discoverCodexRoot({ home: f.home, env: { CODEX_HOME } }), { found: true, path: fallback, source: 'default' });
  }
  assert.equal((await discoverCodexRoot({ home: f.home, env: {} })).source, 'default');
});

test('automatic discovery failure returns a useful nonthrowing result', async t => {
  const f = await fixture(t);
  const result = await discoverCodexRoot({ home: f.home, env: { CODEX_HOME: join(f.base, 'missing') } });
  assert.equal(result.found, false); assert.equal(result.source, 'default');
  assert.equal(result.path, join(f.home, '.codex')); assert.match(result.message, /CODEX_HOME/);
  assert.match(result.message, /environment:/); assert.match(result.message, /default:/);
});

test('POSIX boundaries reject root parent sibling-prefix and traversal escapes', () => {
  const p = nodePath.posix, root = '/codex/sessions';
  assert.equal(insideRoot(root, root + '/2026/item.jsonl', p), true);
  assert.equal(insideRoot(root, root + '/..notes/item.jsonl', p), true);
  for (const target of [root, '/codex', root + '-other/file', root + '/../outside/file', '/elsewhere/file']) assert.equal(insideRoot(root, target, p), false, target);
});

const backslash = String.fromCharCode(92);
const windows = value => value.replaceAll('/', backslash);
test('Windows drive boundaries reject backslash and mixed separator escapes', () => {
  const p = nodePath.win32, root = windows('C:/Users/test/.codex/sessions');
  for (const target of [p.join(root, '2026', 'file.jsonl'), 'c:/Users/test/.codex/sessions/file.jsonl', p.join(root, '..notes', 'file')]) assert.equal(insideRoot(root, target, p), true, target);
  for (const target of [root, p.dirname(root), root + windows('-other/file'), root + windows('/../outside/file'), root + '/../outside/file', windows('D:/Users/test/.codex/sessions/file')]) assert.equal(insideRoot(root, target, p), false, target);
});

test('WSL UNC boundaries support wsl.localhost and wsl$ without crossing distributions or shares', () => {
  const p = nodePath.win32;
  for (const host of ['wsl.localhost', 'wsl$']) {
    const root = windows('//' + host + '/Ubuntu/home/test/.codex/sessions');
    assert.equal(insideRoot(root, p.join(root, '2026', 'file.jsonl'), p), true);
    for (const target of [root, root + windows('-other/file'), root + windows('/../outside/file'), windows('//' + host + '/Debian/home/test/.codex/sessions/file'), windows('//other-server/Ubuntu/home/test/.codex/sessions/file'), windows('C:/file')]) assert.equal(insideRoot(root, target, p), false, target);
  }
});

test('external root binds scan index archives prepare and snapshot provenance', async t => {
  const f = await fixture(t), codexHome = f.external;
  const path = join(codexHome, 'sessions', 'selected.jsonl'); await writeFile(path, session('selected'));
  await mkdir(join(codexHome, 'archived_sessions'));
  const archived = join(codexHome, 'archived_sessions', 'archive.jsonl'); await writeFile(archived, session('archive'));
  await writeFile(join(codexHome, 'session_index.jsonl'), jsonl([{ id: 'selected', thread_name: 'Selected root title' }]));
  await mkdir(join(f.home, '.codex', 'sessions'), { recursive: true });
  const wrong = join(f.home, '.codex', 'sessions', 'wrong.jsonl'); await writeFile(wrong, session('wrong'));
  await writeFile(join(f.home, '.codex', 'session_index.jsonl'), jsonl([{ id: 'selected', thread_name: 'Wrong root title' }]));
  const scanned = await scanCodex({ home: f.home, codexHome, includeArchived: true });
  assert.equal(scanned.sessions.length, 2); assert.equal(scanned.sessions.find(s => !s.archived).title, 'Selected root title');
  for (const sourcePath of [path, archived]) {
    const prepared = await prepareSession({ home: f.home, codexHome: join(codexHome, 'sessions', '..'), path: sourcePath });
    assert.equal(prepared.source.codexHome, resolve(codexHome)); assert.equal(prepared.source.path, await realpath(sourcePath)); assert.equal(prepared.turns[0].user, 'synthetic question');
  }
  await assert.rejects(prepareSession({ home: f.home, codexHome, path: wrong }), /inside/);
  const outside = join(f.base, 'outside.jsonl'); await writeFile(outside, session('outside'));
  await assert.rejects(prepareSession({ home: f.home, codexHome, path: outside }), /inside/);
  const escape = join(codexHome, 'sessions', 'escape.jsonl'); await symlink(outside, escape);
  await assert.rejects(prepareSession({ home: f.home, codexHome, path: escape }), /inside/);
});
