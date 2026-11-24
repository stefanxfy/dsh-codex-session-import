// Readable history is data, never a registration of historical tools.
export const ADAPTATION_VERSION = 'readable-v2';
const metadataTypes = new Set(['additional_tools', 'tool_definition', 'tool_definitions', 'function_definition', 'runtime_context', 'environment_context']);
const wrappers = /^\s*<(environment_context|INSTRUCTIONS|skills_instructions|external_codex_apps_[A-Za-z0-9_]+|turn_aborted|subagent_notification|user_instructions|tool_definitions|runtime_context)>/i;
// Exact Codex content-item provenance categories observed in source metadata.
const runtimeKinds = new Set(['agents_md.instructions', 'environments.environment_context']);
const stringify = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
function prefix(value, n) { let end = Math.max(0,n); if (/[\uD800-\uDBFF]/.test(value[end-1] ?? '')) end--; return value.slice(0,end); }

function concise(value) {
  if (value.length <= 600) return value;
  const head = prefix(value,280);
  let tail = value.slice(-240); if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return head + '\n[历史工具摘要省略 ' + (value.length - head.length - tail.length) + ' 字符；可查预算内详情]\n' + tail;
}

// Only explicit encryption structures and the recognizable Fernet wire token are
// unreadable. Ordinary prose/JSON mentioning encryption is never a classifier.
const encryptedKey = /^(?:encrypted(?:_content|_text|_payload)?|ciphertext)$/i;
const encryptedType = /^(?:encrypted(?:_content|_text|_payload)?|ciphertext)$/i;
const cipherToken = /\bgAAAAA[A-Za-z0-9_=-]{74,}/g;
const envelope = /^Message Type: MESSAGE\r?\nTask name: ([^\r\n]+)\r?\nSender: ([^\r\n]+)\r?\nPayload:\r?\n([\s\S]*)$/;
function collaborationData(payload) {
  let encrypted = false, envelopeSender = '';
  const omitted = Symbol('encrypted node');
  // Two views carry provenance, not a magic display string: literal notices in
  // ordinary text must survive while actual encrypted nodes have no body view.
  function clean(value) {
    if (typeof value === 'string') {
      let matched = false;
      const visible = value.replace(cipherToken, () => { matched = true; encrypted = true; return ''; });
      return {sanitized:value.replace(cipherToken,'[加密内容不可读]'),visible:matched && !visible.trim() ? omitted : visible};
    }
    if (Array.isArray(value)) {
      const entries = value.map(clean), visible = entries.map(v=>v.visible).filter(v=>v !== omitted);
      return {sanitized:entries.map(v=>v.sanitized),visible:value.length && !visible.length ? omitted : visible};
    }
    if (!value || typeof value !== 'object') return {sanitized:value,visible:value};
    if (encryptedType.test(value.type ?? '')) { encrypted = true; return {sanitized:{type:value.type,notice:'[加密内容不可读]'},visible:omitted}; }
    const entries = Object.entries(value).map(([key,v]) => {
      if (encryptedKey.test(key)) { if (v) encrypted = true; return [key,{sanitized:'[加密内容不可读]',visible:omitted}]; }
      return [key,clean(v)];
    });
    const visibleEntries = entries.filter(([,v])=>v.visible !== omitted);
    return {sanitized:Object.fromEntries(entries.map(([key,v])=>[key,v.sanitized])),visible:entries.length && !visibleEntries.length ? omitted : Object.fromEntries(visibleEntries.map(([key,v])=>[key,v.visible]))};
  }
  const {sanitized,visible} = clean(payload);
  const internal = new Set(['type','id','message_id','agent_id','thread_id','task_id','sender','sender_name','agent_name','author','recipient','recipient_id','recipient_name','meta','metadata','internal_chat_message_metadata_passthrough']);
  const textTypes = new Set(['text','input_text','output_text','summary_text']);
  const isText = value => value && typeof value === 'object' && !Array.isArray(value) && textTypes.has(value.type) && Object.keys(value).every(key=>['type','text','content'].includes(key));
  function readable(value, business = false) {
    if (value === omitted) return '';
    if (typeof value === 'string') {
      const match = envelope.exec(value);
      if (match) { envelopeSender ||= match[2]; return readable(match[3]); }
      return value;
    }
    if (!business && isText(value)) return readable(value.text ?? value.content);
    if (!business && Array.isArray(value) && value.length && value.every(v=>typeof v === 'string' || isText(v))) return value.map(v=>readable(v)).join('\n');
    // Unknown/business objects are data, not routing envelopes. Preserve every
    // nonencrypted key/value (including nested IDs, false, zero, and null).
    return JSON.stringify(value) ?? '';
  }
  const body = visible === omitted ? '' : Object.entries(visible).filter(([key])=>!internal.has(key)).map(([key,value])=>{
    if (['text','content','message','payload','data'].includes(key)) return readable(value,key === 'data');
    return JSON.stringify({[key]:value});
  }).filter(value=>value !== '').join('\n').trim();
  const sender = envelopeSender || sanitized.sender_name || sanitized.agent_name || sanitized.sender?.name || sanitized.author?.name || (typeof sanitized.sender === 'string' ? sanitized.sender : typeof sanitized.author === 'string' ? sanitized.author : '未知代理');
  const name = prefix(String(sender).split('/').filter(Boolean).at(-1)?.replace(/[\r\n]/g,' ') || '未知代理',128);
  return {sanitized, sender:name, body, encrypted};
}
function collaborationNotice(sender, count) {
  return '子代理 ' + sender + ' 发回' + (count === 1 ? '一条' : count + ' 条') + '协作消息，正文加密，无法读取';
}

export function createAdapter(presentation, budget, warn) {
  const stats = { filteredMetadata:0, mergedToolRecords:0, toolSummaryTurns:0, schemaOutputs:0, truncatedDetails:0, unknownSources:0, collaborationMessages:0, unreadableCollaborations:0, mergedCollaborationNotices:0, truncatedCollaborations:0 };
  function message(p) {
    if (presentation !== 'readable' || p.role !== 'user') return p;
    const content = Array.isArray(p.content) ? p.content : [p.content];
    const metadata = p.internal_chat_message_metadata_passthrough ?? p.metadata ?? {};
    const kinds = metadata.content_item_kinds;
    const aligned = Array.isArray(kinds) && kinds.length === content.length;
    const ambiguous = Array.isArray(kinds) && kinds.length > 0 && !aligned;
    if (ambiguous) { stats.unknownSources++; warn('Mixed historical metadata boundary ambiguous; all user content retained'); return p; }
    const adapted = content.map((value,index) => {
      const kind = aligned ? kinds[index] : undefined;
      // Explicit user provenance wins even when a block has a runtime-looking type.
      if (kind === 'user.text' || kind === 'user.image') return value;
      const rawText = typeof value === 'string' ? value : value?.text ?? '';
      const runtimeKind = typeof kind === 'string' && (/^harness(?:\.|$)/.test(kind) || metadataTypes.has(kind) || runtimeKinds.has(kind));
      if (runtimeKind || (!kind && metadataTypes.has(value?.type))) { stats.filteredMetadata++; return null; }
      if (kind || wrappers.test(rawText) || /^\s*# AGENTS\.md instructions/.test(rawText)) {
        stats.unknownSources++; warn('Unknown historical content provenance retained; runtime-looking text is not evidence of runtime origin');
      }
      return value;
    });
    return {...p,content:adapted};
  }
  function collaboration(payload) {
    const {sanitized,sender,body,encrypted} = collaborationData(payload);
    stats.collaborationMessages++;
    const unreadable = encrypted && !body;
    if (encrypted) { stats.unreadableCollaborations++; warn('Encrypted collaboration content not decrypted; readable content only is imported'); }
    const label = '子代理 ' + sender + '：\n';
    const suffix = encrypted ? '\n[部分协作正文加密，无法读取]' : '';
    let text = unreadable ? collaborationNotice(sender,1) : label + (body || '[未提供可读协作正文]') + suffix;
    if (text.length > budget) { const marker = '\n[协作正文超出预算，已截断]'; text = prefix(text,Math.max(0,budget-marker.length-suffix.length)) + marker + suffix; stats.truncatedCollaborations++; }
    const raw = JSON.stringify(sanitized), output = prefix(raw,budget);
    return {kind:'collaboration',name:'agent_message',text,sender,unreadable,count:1,output,truncated:output !== raw};
  }
  function turn(source) {
    if (presentation !== 'readable') return {turn:source,details:[]};
    if (source.adaptation?.version === ADAPTATION_VERSION) return {turn:source,details:source.adaptation.details};
    const tools = source.items.filter(item => item.kind === 'tool');
    const collaborations = source.items.filter(item => item.kind === 'collaboration');
    const metadata = source.items.filter(item => item.kind === 'metadata');
    if (!tools.length && !metadata.length && !collaborations.length) return {turn:source,details:[]};
    stats.mergedToolRecords += tools.length; if (tools.length) stats.toolSummaryTurns++;
    const details = source.items.filter(item => ['tool','metadata','collaboration'].includes(item.kind)).map(item => {
      // One existing per-tool budget shared by output, ID and args; no full-source copy.
      let remaining = budget;
      const take = value => { const raw = stringify(value), kept = prefix(raw,remaining); remaining -= kept.length; return kept; };
      const callId = prefix(stringify(item.callId ?? ''), Math.min(256, Math.floor(budget / 4))); remaining -= callId.length;
      const args = prefix(stringify(item.arguments ?? ''), Math.floor(budget / 4)); remaining -= args.length;
      const output = take(item.output);
      const truncated = item.truncated || /\[Historical tool output: \d+ characters omitted\]/.test(output) || output !== stringify(item.output) || callId !== (item.callId ?? '') || args !== stringify(item.arguments ?? '');
      if (truncated) stats.truncatedDetails++;
      return {kind:item.kind,turn:source.number,sourceLine:item.sourceLine,...(item.outputSourceLine === undefined ? {} : {outputSourceLine:item.outputSourceLine}),name:item.name || 'unknown',callId,arguments:args,output,truncated,unpaired:!!item.unpaired};
    });
    const rows = tools.map(item => {
      const schema = item.schemaOutput || isSchemaOutput(item.output);
      if (schema) stats.schemaOutputs++;
      const result = schema ? '结构化工具定义／schema 已转入详情（预算内原文）' : concise(stringify(item.output));
      return '- ' + (item.name || 'unknown') + '（源行 ' + item.sourceLine + (item.unpaired ? '，未配对' : '') + '）：' + result;
    });
    const summary = {kind:'tool-summary',text:'历史工具摘要\n' + rows.join('\n'),sourceLine:(tools[0] ?? metadata[0] ?? collaborations[0]).sourceLine,time:tools.reduce((time,item) => Math.max(time,item.time || 0),0)};
    let emitted = false;
    // Merge on original adjacency before tools/metadata disappear. Every source
    // message retains its own bounded detail and source line.
    const merged = [];
    for (const item of source.items) {
      const previous = merged.at(-1);
      if (item.kind === 'collaboration' && item.unreadable && previous?.kind === 'collaboration' && previous.unreadable && previous.sender === item.sender) {
        previous.count++; previous.sourceLines.push(item.sourceLine);
        previous.text = collaborationNotice(previous.sender,previous.count);
        previous.time = Math.max(previous.time || 0,item.time || 0);
        stats.mergedCollaborationNotices++;
      } else merged.push(item.kind === 'collaboration' ? {...item,sourceLines:[item.sourceLine]} : item);
    }
    const items = merged.flatMap(item => {
      if (item.kind === 'metadata' || item.kind === 'boundary') return [];
      if (item.kind === 'collaboration') return [{kind:'assistant',text:item.text,time:item.time,sourceLine:item.sourceLine,sourceLines:item.sourceLines,collaboration:{sender:item.sender,unreadable:item.unreadable,count:item.count}}];
      if (item.kind !== 'tool') return [item];
      if (emitted) return []; emitted = true; return [summary];
    });
    // Preserve in-memory re-adaptation without placing private details in the
    // enumerable conversation shape. The top-level details remain serializable.
    const adapted = {...source,items};
    Object.defineProperty(adapted,'adaptation',{value:{version:ADAPTATION_VERSION,details}});
    return {turn:adapted,details};
  }
  return {stats,message,collaboration,turn};
}

// Structural classification only: never keyword-filter prose, code or ordinary JSON.
export function isSchemaOutput(output) {
  let value;
  try { value = JSON.parse(output); } catch { return false; }
  const schema = v => v && typeof v === 'object' && !Array.isArray(v) && ((v.type === 'object' && v.properties && typeof v.properties === 'object') || (v.type === 'function' && (v.function?.parameters || v.parameters)));
  return schema(value) || (Array.isArray(value) && value.some(schema)) || (value && typeof value === 'object' && ['tools','functions'].some(key => Array.isArray(value[key]) && value[key].some(schema)));
}
