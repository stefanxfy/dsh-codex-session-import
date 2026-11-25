import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { discoverCodexRoot } from './source-root.js';
import { scanCodex, prepareSession } from './core.js';
import { buildEvents } from './events.js';
import { detailPage } from './details.js';
import { ADAPTATION_VERSION as READABLE_VERSION } from './adapt.js';
function identityOptions(options){const {presentation,...legacy}=options;return presentation==='readable'?{...legacy,presentation,conversionVersion:READABLE_VERSION}:legacy;}
import { PROMPT_VERSION } from './summary.js';
let globalTail = Promise.resolve();
function enqueue(fn) { const result = globalTail.then(fn); globalTail = result.catch(() => {}); return result; }
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function normalizeOptions(options = {}) {
  if (options.historyMode === 'summary') throw fail('AI_SUMMARY_DISABLED', 'AI summary is disabled; use truncate history');
  const value = { keepTurns: options.keepTurns ?? 30, historyMode: options.historyMode ?? 'truncate', toolOutputChars: options.toolOutputChars ?? 8000, presentation: options.presentation ?? 'audit' };
  if (!['audit','readable'].includes(value.presentation) || !Number.isInteger(value.keepTurns) || value.keepTurns < 1 || value.keepTurns > 500 || value.historyMode !== 'truncate' || !Number.isInteger(value.toolOutputChars) || value.toolOutputChars < 256 || value.toolOutputChars > 64000) throw fail('INVALID_OPTIONS', 'Invalid import options');
  return value;
}
export function createService(deps, config = {}) {
  for (const key of ['previewTtlMs','maxPreviewBytes','maxPreviews','maxJobs','contextWarningChars','summaryTimeoutMs','maxSummaryCacheEntries']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > (key === 'summaryTimeoutMs' ? 2147483647 : 1099511627776))) throw fail('INVALID_CONFIG','Importer '+key+' must be a positive bounded integer');
  }
  const operations = new Set();
  let batchId = randomUUID();
  const previews = new Map(), sources = new Map(), jobs = new Map(), manifest = new Map();
  const lifetime = new AbortController(); let disposed = false, previewBytes = 0;
  let sourceDiscovery=null, selectedManual=null, scanTail=Promise.resolve(), sourceConfigWarning='', scanning=false;
  const sourceConfigPath=deps.cacheRoot&&join(deps.cacheRoot,'source-config.json');
  const sourceConfigLoaded=sourceConfigPath?readFile(sourceConfigPath,'utf8').then(raw=>{const value=JSON.parse(raw);if(typeof value.codexHome==='string'&&value.codexHome.trim())selectedManual=value.codexHome;}).catch(error=>{if(error.code!=='ENOENT')sourceConfigWarning='保存的来源配置不可读取，请重新填写 CODEX_HOME。';}):Promise.resolve();
  const ttl = config.previewTtlMs ?? 15 * 60000, maxBytes = config.maxPreviewBytes ?? Number.MAX_SAFE_INTEGER;
  const manifestPath = deps.cacheRoot && join(deps.cacheRoot, 'manifest.json');
  const loaded = manifestPath ? readFile(manifestPath, 'utf8').then(text => { for (const [key,value] of Object.entries(JSON.parse(text))) manifest.set(key,value); }).catch(error => { if (error.code !== 'ENOENT') throw fail('MANIFEST_INVALID', 'Cannot load import manifest'); }) : Promise.resolve();
  loaded.catch(()=>{});
  async function atomicJson(path,value) { await mkdir(deps.cacheRoot,{recursive:true,mode:0o700}); const tmp=path+'.'+randomUUID()+'.tmp'; await writeFile(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'}); await rename(tmp,path); }
  function alive() { if (disposed) throw fail('DISPOSED','Importer disposed'); }
  function busyJobs() { return [...jobs.values()].some(j=>['queued','running'].includes(j.status)); }
  function renew() { const expires=Date.now()+ttl; for(const p of previews.values()) p.expires=expires; }
  function prune() { if(operations.size || busyJobs()) return; for (const [id,p] of previews) if (p.expires < Date.now()) { previews.delete(id); previewBytes -= p.size; } }
  function publicJob(job) { return structuredClone({ id: job.id, status: job.status, items: job.items }); }
  async function saveManifest() { if (!manifestPath) return; await mkdir(deps.cacheRoot,{recursive:true,mode:0o700}); const tmp = manifestPath + '.' + randomUUID() + '.tmp'; await writeFile(tmp,JSON.stringify(Object.fromEntries(manifest)),{mode:0o600,flag:'wx'}); await rename(tmp,manifestPath); }
  const limits = {maxPreviews:config.maxPreviews ?? Number.MAX_SAFE_INTEGER,maxPreviewBytes:maxBytes};
  const service = {
    resetPreviews() { alive(); if(operations.size || busyJobs()) throw fail('BUSY','A preview or import is active; finish or cancel it first'); previews.clear();previewBytes=0;batchId=randomUUID();return {batchId,limits}; },
    async scan(options = {}) {
      const pending=scanTail.then(async()=>{
      scanning=true;try{
      alive();await loaded;await sourceConfigLoaded;
      const signal=AbortSignal.any([lifetime.signal,...(options.signal?[options.signal]:[])]);signal.throwIfAborted();
      const explicit=Object.prototype.hasOwnProperty.call(options,'codexHome');
      if(explicit && typeof options.codexHome!=='string')throw fail('INVALID_CODEX_HOME','CODEX_HOME 必须是目录字符串');
      const manual=explicit?(options.codexHome.trim()||null):selectedManual;
      const discover=deps.discoverCodexRoot ?? discoverCodexRoot;let discovery;
      try{discovery=await discover({manual,home:deps.home,env:deps.env ?? process.env});}
      catch(error){if(explicit||!manual)throw error;discovery=await discover({home:deps.home,env:deps.env ?? process.env});discovery={...discovery,message:'保存的 CODEX_HOME 不可用；'+(discovery.message ?? '已回退自动发现。')};}
      signal.throwIfAborted();alive();
      const changingRoot=sourceDiscovery && sourceDiscovery.path!==discovery.path;
      if(changingRoot && (operations.size || busyJobs()))throw fail('BUSY','正在预览或导入，请完成或取消后再更换 CODEX_HOME');
      const result=discovery.found?await (deps.scanCodex ?? scanCodex)({home:deps.home,codexHome:discovery.path,includeArchived:options.includeArchived===true,includeSubagents:options.includeSubagents===true,signal}):{sessions:[],workspaces:[]};
      signal.throwIfAborted();alive();
      if(changingRoot)service.resetPreviews();
      if(explicit){if(sourceConfigPath)await atomicJson(sourceConfigPath,{codexHome:manual?discovery.path:null});selectedManual=manual?discovery.path:null;sourceConfigWarning='';}
      sourceDiscovery={...discovery,...(sourceConfigWarning?{message:[discovery.message,sourceConfigWarning].filter(Boolean).join(' ')}:{})};
      sources.clear();
      const sessions = result.sessions.map(s => { const id = s.id; sources.set(id,{...s,codexHome:discovery.path}); const {path,...publicSource} = s; return {...publicSource,id}; });
      return {...result,sessions,limits,sourceDiscovery,capabilities:{presentations:['audit','readable'],adaptationVersion:READABLE_VERSION,details:true,sourceRoot:true,aiSummary:false},targets:(await deps.workspaceRegistry.list()).map(w=>({id:w.id,title:w.title ?? w.path ?? w.id,path:w.path}))};
      }finally{scanning=false;}
      });scanTail=pending.catch(()=>{});return pending;
    },
    async preview(request) {
      if (request?.confirmSummary === true) throw fail('AI_SUMMARY_DISABLED', 'AI summary confirmation is disabled');
      const options = normalizeOptions(request?.options);
      alive();if(scanning)throw fail('BUSY','正在切换或扫描来源，请等待扫描完成再预览'); const source = sources.get(request?.sessionId); if (!source) throw fail('SOURCE_NOT_FOUND','Scan again to select a source');
      if(request.batchId !== undefined && request.batchId !== batchId) throw fail('BATCH_CHANGED','Preview batch changed; begin a new preview batch');
      prune(); renew();
      const requestBatch = batchId;
      const signal = AbortSignal.any([lifetime.signal,...(request.signal ? [request.signal] : []),AbortSignal.timeout(config.summaryTimeoutMs ?? 30 * 60000)]);
      const pending = enqueue(async () => {
        signal.throwIfAborted();
        if(requestBatch !== batchId) throw fail('BATCH_CHANGED','Preview batch changed');
        renew();
        const prepared = await (deps.prepareSession ?? prepareSession)({path:source.path,home:deps.home,codexHome:source.codexHome,...options,signal});
        prepared.source.codexHome ??= source.codexHome;
        prepared.source.title = source.title ?? prepared.source.title;
        const warnings = [...prepared.warnings];
        const retained = prepared.stats.serializedChars ?? JSON.stringify(prepared.turns).length;
        if (retained > (config.contextWarningChars ?? 200000)) warnings.push('保留历史约 '+retained+' 字符，可能超过模型上下文；请减少轮数或工具输出。DSH续聊可能压缩或超限，本插件不保证可直接续聊。');
        const {path,...safeSource} = prepared.source;
        const adaptation=prepared.adaptation;
        const base = {source:{...safeSource},stats:prepared.stats,warnings,adaptation:{version:options.presentation==='readable'?READABLE_VERSION:'audit-v1',presentation:options.presentation,stats:adaptation?.stats ?? {},samples:(adaptation?.details ?? []).slice(0,2).map(record=>({sourceLine:record.sourceLine,kind:record.kind,name:record.name,before:String(record.output ?? record.arguments ?? '').slice(0,700),after:record.kind==='metadata'?'已识别运行时元信息，不进入正文':record.kind==='collaboration'?'协作消息已转为中文历史说明；内部标识保留在只读详情':'历史工具结果汇入每轮摘要；参数与调用 ID 保留在只读详情',truncated:!!record.truncated}))}};
        const heldBase={prepared:{...prepared,olderChunks:[]},summary:'',options,sessionId:request.sessionId,batchId,expires:Date.now()+ttl};
        const reservedSize=Buffer.byteLength(JSON.stringify(heldBase))+128;
        if(previews.size+1 > limits.maxPreviews || previewBytes+reservedSize > maxBytes) throw fail('CAPACITY_LIMIT','This batch exceeds private preview capacity; select fewer sessions or reduce turns/tool output');
        const summary = '';
        signal.throwIfAborted();
        const conversion = (deps.buildEvents ?? buildEvents)(prepared,{id:randomUUID(),summary}); warnings.push(...(conversion.warnings ?? []));
        // Snapshot contents remain private and bounded; preview displays only labelled excerpts.
        const turnsPreview = prepared.turns.slice(0,3).map(t=>({time:t.time,user:t.user.slice(0,2000),items:t.items.slice(0,3).map(i=>i.kind === 'assistant' || i.kind === 'tool-summary' ? {kind:i.kind,text:String(i.text ?? '').slice(0,2000),...(i.reasoning?{reasoning:String(i.reasoning).slice(0,2000)}:{})} : {kind:i.kind,name:i.name,output:String(i.output ?? '').slice(0,2000)})}));
        const held = {...heldBase,summary,expires:Date.now()+ttl};
        held.size = Buffer.byteLength(JSON.stringify(held));
        const previewId = randomUUID(); previews.set(previewId,held); previewBytes += held.size;
        return {...base,batchId,previewId,summary,turnsPreview};
      });
      operations.add(pending);
      try { return await pending; } finally { renew(); operations.delete(pending); }
    },
    async details(request={}) {
      alive();await loaded;prune();
      if((typeof request.previewId==='string') === (typeof request.importedId==='string'))throw fail('INVALID_DETAILS','请选择一个预览或已导入会话');
      if(!Number.isSafeInteger(request.offset ?? 0)||(request.offset ?? 0)<0||!Number.isSafeInteger(request.limit ?? 10)||(request.limit ?? 10)<1||(request.limit ?? 10)>20)throw fail('INVALID_DETAILS','详情分页参数无效');
      let entry;
      if(request.previewId){const held=previews.get(request.previewId);if(!held)throw fail('PREVIEW_EXPIRED','预览已失效，请重新预览；不会重新导入');renew();entry={sourceSnapshot:held.prepared.source,options:held.options};}
      else entry=[...manifest.values()].find(value=>value?.id===request.importedId || value===request.importedId);
      if(!entry)throw fail('IMPORT_NOT_FOUND','未找到已授权的导入记录');
      if(!entry.sourceSnapshot)throw fail('SOURCE_UNAVAILABLE','仅保存去重标识，没有导入后来源快照；请在导入前预览核查');
      const snapshot=entry.sourceSnapshot;const signal=AbortSignal.any([lifetime.signal,...(request.signal?[request.signal]:[]),AbortSignal.timeout(60000)]);
      const pending=enqueue(async()=>{try{signal.throwIfAborted();const prepared=await (deps.prepareSession ?? prepareSession)({path:snapshot.path,home:deps.home,codexHome:snapshot.codexHome ?? join(deps.home ?? homedir(),'.codex'),...normalizeOptions({...entry.options,historyMode:'truncate'}),sourceBytes:snapshot.bytes,signal});if(prepared.source.sha256!==snapshot.sha256)throw fail('SOURCE_CHANGED','原始快照已改写，无法核验详情；已有会话保持不变');if(Buffer.byteLength(JSON.stringify(prepared))>maxBytes)throw fail('DETAIL_CAPACITY','详情超过本机核查预算，请直接检查只读来源');const page=detailPage(prepared,request);if(request.importedId){const importedVersion=entry.conversionVersion ?? (entry.options?.presentation==='readable'?'readable-v1':'audit-v1');page.detail.importedConversionVersion=importedVersion;page.detail.parsedConversionVersion=prepared.adaptation?.version ?? READABLE_VERSION;if(entry.options?.presentation==='readable'&&importedVersion!==READABLE_VERSION)page.detail.warnings=[...page.detail.warnings,'原导入采用 '+importedVersion+'；本次仅按 '+READABLE_VERSION+' 解析绑定来源供核查，不代表旧会话正文，也不会修改原会话。'];}return page;}catch(error){if(signal.aborted||['SOURCE_CHANGED','DETAIL_CAPACITY'].includes(error.code))throw error;throw fail('SOURCE_UNAVAILABLE','原始来源不可读取或快照已变化；已有会话保持不变');}});
      operations.add(pending);try{return await pending;}finally{operations.delete(pending);}
    },
    async start(request) {
      alive();if(scanning)throw fail('BUSY','正在切换或扫描来源，请等待扫描完成再导入'); await loaded;if(scanning)throw fail('BUSY','正在切换或扫描来源，请等待扫描完成再导入'); prune();
      const ids = request?.previewIds;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw fail('INVALID_PREVIEWS','Select unique reviewed previews');
      const workspace = deps.workspaceRegistry.get(request.targetWorkspaceId); if (!workspace) throw fail('TARGET_NOT_FOUND','Target workspace not found');
      const held = ids.map(id => { const p=previews.get(id); if (!p) throw fail('PREVIEW_EXPIRED','Preview missing or expired; preview again'); return p; });
      if (jobs.size >= (config.maxJobs ?? 64)) { const old=[...jobs.values()].find(j=>['completed','cancelled'].includes(j.status)); if (!old) throw fail('BUSY','Too many jobs'); jobs.delete(old.id); }
      const job = {id:randomUUID(),status:'queued',controller:new AbortController(),items:ids.map((id,i)=>({previewId:id,sessionId:held[i].sessionId,status:'queued'}))}; jobs.set(job.id,job);
      // Jobs keep tokens, not copies of transcript snapshots; queued eviction fails safely.
      job.done = enqueue(async () => {
        job.status='running'; const signal=AbortSignal.any([lifetime.signal,job.controller.signal]);
        for (let i=0;i<ids.length;i++) {
          const item=job.items[i]; let artifactId;
          if (signal.aborted) { item.status='cancelled'; continue; }
          try {
            const p=previews.get(ids[i]); if (!p) throw fail('PREVIEW_EXPIRED','Preview expired; preview again');
            const key=digest([p.prepared.source.sha256,request.targetWorkspaceId,identityOptions(p.options),PROMPT_VERSION]);
            if (manifest.has(key)) { item.status='skipped'; item.importedId=manifest.get(key).id ?? manifest.get(key); continue; }
            item.status='validating'; const id=deps.SessionId ? deps.SessionId(randomUUID()) : randomUUID();
            const conversion=(deps.buildEvents ?? buildEvents)(p.prepared,{id,summary:p.summary});
            const header={version:deps.version ?? 4,id,createdAt:conversion.createdAt,cwd:workspace.path,isSeeded:false};
            deps.Session.create(id,conversion.events,header); signal.throwIfAborted();
            item.status='writing'; const handle=await deps.persistence.create(header,{signal}); artifactId=id;
            try { await handle.append(conversion.events); await handle.flush(); } finally { await handle.close(); }
            // Once persistence is committed, finish attachment even if cancellation arrives.
            deps.projectionCache?.coldSnapshot(header,0,conversion.events);
            await workspace.attachSession(id);
            manifest.set(key,{id});
            try { await saveManifest(); } catch { item.warning='Session attached, but durable duplicate manifest failed; retry after restart may duplicate'; }
            item.importedId=id; item.status='completed';
          } catch (error) {
            item.status=signal.aborted && !artifactId ? 'cancelled' : 'failed';
            item.error={code:error.code ?? 'IMPORT_FAILED',message:artifactId ? 'Import failed after creating artifact '+artifactId+'; inspect/remove this orphan manually before retry' : 'Import failed ('+(error.code ?? 'IMPORT_FAILED')+'); preview again or retry'};
            if (artifactId) item.artifactId=artifactId;
          }
        }
        job.status=signal.aborted ? 'cancelled' : 'completed';
      });
      return publicJob(job);
    },
    status(id) { alive(); const job=jobs.get(id); if (!job) throw fail('JOB_NOT_FOUND','Job not found'); return publicJob(job); },
    cancel(id) { const job=jobs.get(id); if (!job) throw fail('JOB_NOT_FOUND','Job not found'); job.controller.abort(); return publicJob(job); },
    async dispose() { disposed=true; lifetime.abort(); for(const job of jobs.values()) job.controller.abort(); await Promise.allSettled([scanTail,...operations,...[...jobs.values()].map(j=>j.done)]); previews.clear();  sources.clear();  previewBytes=0; }
  };
  return service;
}
