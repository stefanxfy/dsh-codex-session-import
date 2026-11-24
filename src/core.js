import { open, realpath, stat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { insideRoot } from './source-root.js';
export { insideRoot } from './source-root.js';
import { createHash } from 'node:crypto';
import { createAdapter, ADAPTATION_VERSION, isSchemaOutput } from './adapt.js';

const LINE_BYTES = 16 * 1024 * 1024;
const CHUNK_CHARS = 24000;
const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const epoch = value => Number.isFinite(value) ? value : (Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0);
function check(signal) { signal?.throwIfAborted(); }
function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(name + ' is out of range'); }
async function canonical(path, codexHome) {
  const target = await realpath(path);
  for (const dir of ['sessions', 'archived_sessions']) {
    let root;
    try { root = await realpath(join(codexHome, dir)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (insideRoot(root, target)) return target;
  }
  throw new Error('Source must be inside the selected Codex sessions or archived_sessions directory');
}

async function openSource(path, codexHome) {
  const resolved = await canonical(path, codexHome);
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const checked = await canonical(resolved, codexHome), held = await handle.stat(), named = await stat(checked);
    if (checked !== resolved || held.ino !== named.ino || held.dev !== named.dev) throw new Error('Source path changed while opening');
    return { resolved, handle };
  } catch (error) { await handle.close(); throw error; }
}

// Fixed-size fd reads: no whole-file readFile, no readline unbounded line accumulation.
async function* lines(handle, bytes, { signal, maxLineBytes = LINE_BYTES, hash, onProgress } = {}) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0, pieces = [], size = 0, number = 0;
  while (position < bytes) {
    check(signal);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, bytes - position), position);
    if (!bytesRead) throw new Error('Source snapshot was shortened during read');
    const chunk = buffer.subarray(0, bytesRead);
    hash?.update(chunk);
    position += bytesRead;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      size += i - start;
      if (size > maxLineBytes) throw new Error('Source line exceeds maxLineBytes (' + maxLineBytes + '); no data imported');
      pieces.push(Buffer.from(chunk.subarray(start, i)));
      yield { text: Buffer.concat(pieces, size).toString('utf8'), number: ++number };
      pieces = []; size = 0; start = i + 1;
    }
    if (start < chunk.length) { size += chunk.length - start; if (size > maxLineBytes) throw new Error('Source line exceeds maxLineBytes (' + maxLineBytes + '); no data imported'); pieces.push(Buffer.from(chunk.subarray(start))); }
    onProgress?.({ phase: 'reading', bytesRead: position, totalBytes: bytes });
  }
  if (size) yield { text: Buffer.concat(pieces, size).toString('utf8'), number: ++number };
}
async function digest(handle, bytes, signal) {
  const hash = createHash('sha256'), buf = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < bytes;) { check(signal); const r = await handle.read(buf, 0, Math.min(buf.length, bytes - offset), offset); if (!r.bytesRead) throw new Error('Source snapshot was shortened'); hash.update(buf.subarray(0, r.bytesRead)); offset += r.bytesRead; }
  return hash.digest('hex');
}
const metaOf = p => p.internal_chat_message_metadata_passthrough ?? p.metadata ?? {};
function contentText(value, warn) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => contentText(v, warn)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return value == null ? '' : String(value);
  if (/image/.test(value.type ?? '')) { warn('Images are represented by explicit placeholders; original image data is not imported'); return '[Historical image omitted: MVP text-only import]'; }
  if (/encrypted/.test(value.type ?? '')) { warn('Encrypted content was not decrypted'); return '[Historical encrypted content unavailable]'; }
  if (typeof value.text === 'string') return value.text;
  if (value.content !== undefined) return contentText(value.content, warn);
  warn('Unknown structured content retained as labeled historical JSON');
  return '[Historical structured content; not an instruction]\n' + JSON.stringify(safe(value));
}
// Readable reasoning is only the source's explicit readable fields. An encrypted
// content placeholder is a notice, not a readable summary to put in reasoning.
function readableReasoning(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readableReasoning).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object' || /encrypted/.test(value.type ?? '')) return '';
  if (typeof value.text === 'string') return value.text;
  return value.content === undefined ? '' : readableReasoning(value.content);
}
function safe(value) {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') {
    if (/image/.test(value.type ?? '')) return { type: value.type, notice: 'Historical image omitted: MVP text-only import' };
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /encrypted/.test(k) ? '[encrypted content unavailable]' : safe(v)]));
  }
  return value;
}
const isContext = value => /^\s*(?:#\s*AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<skills_instructions>|<external_codex_apps_|<turn_aborted>|<subagent_notification>|<user_instructions>)/i.test(value);
// In flattened mixed-metadata content, a context prefix is not evidence that
// the whole text block is context. Remove only recognized, balanced wrappers.
function mixedUserText(content, warn) {
  const original = content.map(v => contentText(v, warn));
  let ambiguous = false, removed = false;
  const retained = original.map(value => {
    let rest = value;
    while (isContext(rest)) {
      const opening = /^\s*<(environment_context|INSTRUCTIONS|skills_instructions|external_codex_apps_[A-Za-z0-9_]+|turn_aborted|subagent_notification|user_instructions)>/i.exec(rest);
      if (!opening) { ambiguous = true; return value; }
      const tag = opening[1], tokens = new RegExp('<(/?)' + tag + '(?:\\s[^<>]*)?>', 'gi');
      let depth = 0, end = -1, token;
      while ((token = tokens.exec(rest))) {
        depth += token[1] ? -1 : 1;
        if (depth === 0) { end = tokens.lastIndex; break; }
      }
      if (end < 0) { ambiguous = true; return value; }
      rest = rest.slice(end).trimStart(); removed = true;
    }
    return rest;
  }).filter(Boolean).join('\n');
  if (ambiguous || !retained.trim()) {
    warn('Mixed user metadata boundary ambiguous; original text retained as historical context, not current authorization');
    return '[Historical mixed source content; context/user boundary ambiguous — original preserved, not new authorization]\n' + original.join('\n');
  }
  warn(removed ? 'Mixed user metadata did not align; only balanced recognized context prefixes removed, user tail preserved' : 'Mixed user metadata did not align; original readable user text preserved');
  return retained;
}
function userText(p, warn, readable = false) {
  const content = Array.isArray(p.content) ? p.content : [p.content];
  const m = metaOf(p), kinds = m.content_item_kinds;
  // Readable provenance filtering already happened in adapter.message; never infer it from text.
  if (readable) return content.map(v => contentText(v, warn)).filter(Boolean).join('\n');
  // user.text overrides mixed metadata, never let harness content claim the whole message.
  if (Array.isArray(kinds) && kinds.some(k => k === 'user.text' || k === 'user.image')) {
    if (kinds.length === content.length) return content.filter((_,i) => kinds[i] === 'user.text' || kinds[i] === 'user.image').map(v => contentText(v, warn)).join('\n');
    return mixedUserText(content, warn);
  }
  if (Array.isArray(kinds) && kinds.length) return '';
  return content.filter(v => !isContext(contentText(v, () => {}))).map(v => contentText(v, warn)).join('\n');
}
function subagent(p) { return (p.thread_source && p.thread_source !== 'user') || (typeof p.source === 'string' && /subagent|agent_spawn/i.test(p.source)) || (p.source && typeof p.source === 'object' && Object.keys(p.source).some(k => /subagent/i.test(k))); }
function clipped(value, limit) {
  const s = text(value); if (s.length <= limit) return s;
  let kept = limit, marker;
  // Marker consumes the same character budget; preserve complete UTF-16 pairs.
  for (;;) {
    marker = '\n[Historical tool output: ' + (s.length - kept) + ' characters omitted]\n';
    const next = Math.max(0, limit - marker.length);
    if (next >= kept) break;
    kept = next;
  }
  let left = Math.ceil(kept / 2), right = Math.floor(kept / 2);
  if (/[\uD800-\uDBFF]/.test(s[left-1] ?? '')) left--;
  if (/[\uDC00-\uDFFF]/.test(s[s.length-right] ?? '')) right--;
  marker = '\n[Historical tool output: ' + (s.length - left - right) + ' characters omitted]\n';
  return s.slice(0,left) + marker + (right ? s.slice(-right) : '');
}
function opaque(path) { return createHash('sha256').update(path).digest('hex'); }

export async function scanCodex({ home = homedir(), codexHome = join(home, '.codex'), includeArchived = false, includeSubagents = false, signal } = {}) {
  const sessions = [], titles = new Map();
  // Optional small-record index supplies edited titles, but never arbitrary paths.
  try {
    const h = await open(join(codexHome, 'session_index.jsonl'), 'r');
    try { const s = await h.stat(); for await (const l of lines(h, s.size, { signal })) { try { const v = JSON.parse(l.text); if (v.id && typeof v.thread_name === 'string') titles.set(v.id, v.thread_name); } catch {} } } finally { await h.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function walk(dir, archived) {
    check(signal);
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      check(signal); const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path, archived); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const { resolved, handle: h } = await openSource(path, codexHome);
      try {
        const s = await h.stat(); let meta = {}, title = '', count = 0, metaSeen = false;
        for await (const l of lines(h, s.size, { signal })) {
          if (++count > 128) break;
          let v; try { v = JSON.parse(l.text); } catch { continue; }
          // Later session_meta rows may be inherited ancestor context, not this file's identity.
          if (v.type === 'session_meta' && !metaSeen) { meta = v.payload ?? {}; metaSeen = true; }
          if (v.type === 'response_item' && v.payload?.type === 'message' && v.payload.role === 'user') title ||= userText(v.payload, () => {}).trim().slice(0,120);
          if (title && meta.id) break;
        }
        const agent = !!subagent(meta); if (agent && !includeSubagents) continue;
        sessions.push({ id: opaque(resolved), title: titles.get(meta.id) || meta.title || title || basename(resolved), cwd: meta.cwd || '', path: resolved, updatedAt: s.mtimeMs, bytes: s.size, archived, subagent: agent });
      } finally { await h.close(); }
    }
  }
  await walk(join(codexHome, 'sessions'), false);
  if (includeArchived) await walk(join(codexHome, 'archived_sessions'), true);
  sessions.sort((a,b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const counts = new Map(); for (const s of sessions) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
  return { workspaces: [...counts].map(([path,count]) => ({path,count})).sort((a,b) => a.path.localeCompare(b.path)), sessions };
}

export async function prepareSession({ path, home = homedir(), codexHome = join(home, '.codex'), keepTurns = 30, historyMode = 'summary', toolOutputChars = 8000, presentation = 'audit', signal, onProgress, sourceBytes, maxLineBytes = LINE_BYTES } = {}) {
  integer(keepTurns, 1, 500, 'keepTurns'); integer(toolOutputChars, 256, 64000, 'toolOutputChars'); integer(maxLineBytes, 1, 1024 * 1024 * 1024, 'maxLineBytes');
  if (!['summary','truncate'].includes(historyMode)) throw new Error('Invalid historyMode');
  if (!['readable','audit'].includes(presentation)) throw new Error('Invalid presentation');
  check(signal); const { resolved, handle: h } = await openSource(path, codexHome);
  const turns = [], olderChunks = [], preUserItems = [], warnings = [], warningSet = new Set();
  const warn = message => { if (!warningSet.has(message)) { warningSet.add(message); warnings.push(message); } };
  const adapter = createAdapter(presentation, toolOutputChars, warn), retainedDetails = new Map();
  let olderText = '', meta = {}, metaSeen = false, current, currentTurnId, totalTurns = 0, filteredMessages = 0, toolItems = 0, lineCount = 0, firstTitle = '', pending = new Map();
  const chunkText = value => { if (historyMode !== 'summary') return; let s = value; while (s.length) { let n = Math.min(CHUNK_CHARS - olderText.length, s.length); if (n < s.length && /[\uD800-\uDBFF]/.test(s[n-1] ?? '')) n--; if (!n) { olderChunks.push(olderText); olderText=''; continue; } olderText += s.slice(0,n); s = s.slice(n); if (olderText.length >= CHUNK_CHARS - 1) { olderChunks.push(olderText); olderText = ''; } } };
  function archive(turn) { chunkText('\n[Historical user]\n' + turn.user + '\n'); for (const item of turn.items) chunkText(item.kind === 'tool' ? '[Historical tool; not executed]\n' + JSON.stringify(item) + '\n' : '[Historical assistant]\n' + item.text + (item.reasoning ? '\n[Readable reasoning summary]\n'+item.reasoning : '') + '\n'); }
  function finish() {
    if (!current) return;
    for (const item of pending.values()) { item.unpaired = true; warn('Tool calls with missing results retained as labeled history'); }
    pending.clear(); const adapted = adapter.turn(current); turns.push(adapted.turn); retainedDetails.set(current.number, adapted.details);
    if (turns.length > keepTurns) { const older = turns.shift(); archive(older); retainedDetails.delete(older.number); } current = undefined;
  }
  function add(item) { item.sourceLine ??= lineCount; if (!current) { warn('Pre-user historical response/tool records retained with first source user as historical prefix; original ancestor user is unavailable'); preUserItems.push(item); return; } current.items.push(item); }
  try {
    const before = await h.stat(); if (!before.isFile()) throw new Error('Source is not a regular file');
    const bytes = sourceBytes ?? before.size; integer(bytes, 0, before.size, 'sourceBytes');
    const hash = createHash('sha256');
    for await (const l of lines(h, bytes, { signal, maxLineBytes, hash, onProgress })) {
      check(signal); lineCount = l.number; if (!l.text.trim()) continue;
      let e; try { e = JSON.parse(l.text); } catch { throw new Error('Invalid or incomplete source JSON at line ' + l.number + '; no data imported'); }
      const p = e.payload ?? {}, time = epoch(e.timestamp);
      if (p.encrypted_content) warn('Encrypted source content not decrypted; readable fields only are imported');
      if (e.type === 'session_meta') { if (!metaSeen) { meta = p; metaSeen = true; } else if (p.id && meta.id && p.id !== meta.id) warn('Inherited session metadata does not replace the source file header identity'); if (p.forked_from_id || p.history_base || p.history_mode === 'paginated') warn('Fork/segment metadata: inherited records in this file are retained; ancestry is not fetched separately (not full history verification)'); continue; }
      if (e.type === 'compacted') { warn('Compacted replacement history ignored to avoid duplicated/reinterpreted user turns'); continue; }
      if (e.type !== 'response_item') continue; // event_msg is a mirror, never another conversation.
      if (p.type === 'message' && p.role === 'user') {
        const user = userText(adapter.message(p), warn, presentation === 'readable'); if (!user.trim()) { filteredMessages++; continue; }
        const tid = metaOf(p).turn_id;
        if (current && tid && tid === currentTurnId && current.items.length === 0) { current.user += '\n' + user; continue; }
        finish(); current = { time, user, sourceLine:l.number, number:totalTurns + 1, items: preUserItems.splice(0) }; currentTurnId = tid; totalTurns++; firstTitle ||= user.trim().slice(0,120); continue;
      }
      if (p.type === 'message') {
        if (p.role === 'assistant') add({kind:'assistant', text:contentText(adapter.message(p).content, warn), time});
        else { filteredMessages++; warn('Historical system/developer/environment instructions filtered; not activated'); }
      } else if (p.type === 'agent_message' && presentation === 'readable') {
        add({...adapter.collaboration(p),time});
      } else if (p.type === 'reasoning') {
        const reasoning = presentation === 'readable' ? readableReasoning(p.summary ?? p.content ?? []) : contentText(p.summary ?? p.content ?? [], warn);
        if (reasoning) add({kind:'assistant', text:presentation === 'readable' ? '' : '[Historical readable reasoning summary; not decrypted chain of thought]', reasoning, time});
        if (presentation === 'readable' && !reasoning) add({kind:'metadata',name:'unreadable-reasoning',output:'[历史推理未提供可读摘要；加密内容不可读]',time});
        if (p.encrypted_content) warn('Encrypted reasoning not decrypted; only readable summaries imported');
      } else if (/^(function_call|custom_tool_call)$/.test(p.type)) {
        const callId = p.call_id, item = {kind:'tool', name: p.name || 'unknown', ...(callId ? {callId} : {}), arguments:p.arguments ?? p.input ?? '', output:'[Historical result missing]', time};
        if (callId && pending.has(callId)) { pending.get(callId).unpaired = true; item.unpaired = true; warn('Duplicate tool call IDs retained without guessing result ownership'); pending.delete(callId); }
        else if (callId) pending.set(callId,item);
        else { item.unpaired = true; warn('Tool calls without IDs retained as labeled history'); }
        toolItems++; add(item);
      } else if (/^(function_call_output|custom_tool_call_output|tool_result)$/.test(p.type)) {
        const callId = p.call_id, match = callId && pending.get(callId), output = clipped(p.output ?? p.content ?? p, toolOutputChars);
        if (match) { match.output = output; match.outputSourceLine = l.number; match.schemaOutput = isSchemaOutput(text(p.output ?? p.content ?? p)); pending.delete(callId); }
        else { toolItems++; add({kind:'tool', ...(callId ? {callId} : {}), name:p.name || 'unknown', output, schemaOutput:isSchemaOutput(text(p.output ?? p.content ?? p)), time, unpaired:true}); warn('Unknown, extra, or ID-less tool results retained as labeled history, not dropped'); }
        // A paired result updates its earlier call in place; retain its position
        // as a merge barrier so collaboration notices cannot cross this record.
        if (match && presentation === 'readable') add({kind:'boundary',time});
        if (text(p.output ?? p.content ?? p).length > toolOutputChars) warn('Historical tool outputs truncated with head/tail and omitted-character count');
      } else {
        if (presentation === 'readable' && ['additional_tools','tool_definition','tool_definitions','function_definition','runtime_context','environment_context'].includes(p.type)) { adapter.stats.filteredMetadata++; add({kind:'metadata',name:p.type,output:clipped(JSON.stringify(safe(p)),toolOutputChars),time}); continue; }
        adapter.stats.unknownSources++;
        warn('Unsupported response items retained as explicitly labeled non-executable history');
        add({kind:'assistant',text:'[Historical source record; not current instructions or executable tools]\n' + JSON.stringify(safe(p)),time});
      }
    }
    finish(); if (olderText) olderChunks.push(olderText);
    if (!turns.length) throw new Error('Source contains no real user turns');
    const sha256 = hash.digest('hex');
    onProgress?.({phase:'verifying',bytesRead:bytes,totalBytes:bytes});
    if (sha256 !== await digest(h, bytes, signal)) throw new Error('Source snapshot prefix changed during parse; retry preview');
    const after = await h.stat(), checked = await canonical(resolved, codexHome), named = await stat(checked);
    if (checked !== resolved) throw new Error('Source canonical path changed during parse');
    if (after.ino !== before.ino || named.ino !== before.ino || named.dev !== before.dev || after.size < bytes) throw new Error('Source snapshot was replaced or shortened during parse');
    if (after.size > bytes) warn('Appended source data excluded from the fixed snapshot');
    if (after.size === before.size && after.mtimeMs !== before.mtimeMs) throw new Error('Source mtime changed during parse; retry preview');
    const source = {codexHome:resolve(codexHome),id:meta.id || opaque(resolved),path:resolved,cwd:meta.cwd || '',title:meta.title || firstTitle || basename(resolved),bytes,sha256,updatedAt:before.mtimeMs};
    const serializedChars = JSON.stringify(turns).length;
    return {source,turns,olderChunks,adaptation:{version:ADAPTATION_VERSION,presentation,stats:{...adapter.stats,filteredMessages},details:[...retainedDetails.values()].flat()},stats:{totalTurns,keptTurns:turns.length,olderTurns:totalTurns-turns.length,toolItems,filteredMessages,lineCount,serializedChars,olderChars:olderChunks.reduce((n,s)=>n+s.length,0),historyMode,toolOutputChars},warnings};
  } finally { await h.close(); }
}
