import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

// Only strict descendants qualify: different drives and UNC shares remain absolute.
export function insideRoot(root, target, pathApi = nodePath) {
  const relative = pathApi.relative(root, target);
  return relative !== '' && !pathApi.isAbsolute(relative) &&
    relative !== '..' && !relative.startsWith('../') && !relative.startsWith('..\\') &&
    !relative.startsWith('..' + pathApi.sep);
}

async function candidateRoot(value) {
  if (typeof value !== 'string' || !nodePath.isAbsolute(value)) throw new Error('CODEX_HOME must be an absolute path');
  const path = nodePath.resolve(value);
  if (!(await stat(path)).isDirectory()) throw new Error('CODEX_HOME must be a directory');
  await access(path, constants.R_OK);
  for (const name of ['sessions', 'archived_sessions']) {
    try {
      const directory = nodePath.join(path, name);
      if ((await stat(directory)).isDirectory()) {
        await access(directory, constants.R_OK);
        return path;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  throw new Error('CODEX_HOME must contain a readable sessions or archived_sessions directory');
}

export async function discoverCodexRoot({ manual, home = homedir(), env = process.env } = {}) {
  const supplied = typeof manual === 'string' ? manual.trim() : manual;
  if (supplied) {
    try { return { found: true, path: await candidateRoot(supplied), source: 'manual' }; }
    catch (cause) {
      const error = new Error('Invalid CODEX_HOME: ' + cause.message, { cause });
      error.code = 'INVALID_CODEX_HOME';
      throw error;
    }
  }
  const failures = [];
  const candidates = [];
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) candidates.push({ path: env.CODEX_HOME.trim(), source: 'environment' });
  candidates.push({ path: nodePath.join(home, '.codex'), source: 'default' });
  for (const candidate of candidates) {
    try { return { found: true, path: await candidateRoot(candidate.path), source: candidate.source }; }
    catch (error) { failures.push(candidate.source + ': ' + error.message); }
  }
  return { found: false, path: nodePath.resolve(home, '.codex'), source: 'default', message: 'No readable Codex sessions directory found. Fill in an absolute CODEX_HOME path. ' + failures.join('; ') };
}
