/* Original implementation. Host integration follows the public DSH ModuleLoader/slots API. */
(function () {
'use strict';
const CHANNEL = '/api';
const CLIENT_VERSION = '0.1.15';
const SOURCE_NOT_READY = '后台未支持来源选择，请重启DSH后重试；未提交目录扫描或导入';
const BACKEND_NOT_READY = '后台尚未加载阅读适配或版本不匹配（需 readable-v2），请重启DSH；未提交导入';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const LABELS = {queued:'等待处理', preparing:'正在准备', summarizing:'正在生成摘要', validating:'正在验证', writing:'正在写入', completed:'已完成', failed:'失败', skipped:'重复，已跳过', cancelled:'已取消', running:'正在处理', cancelling:'正在取消'};
const CSS = ".cri-dialog.cri-page{box-sizing:border-box;width:100%;height:100%;max-height:none;border:0;border-radius:0;display:flex;flex-direction:column;min-height:0}.cri-page .cri-main{flex:1;min-height:0;max-height:none}.cri-page .cri-head,.cri-page .cri-foot{flex-shrink:0}.cri-dialog{color:var(--dsw-alias-label-primary,oklch(22% .01 250));background:var(--dsw-alias-bg-overlay,oklch(99% 0 0));border:1px solid var(--dsw-alias-border-l1,oklch(75% 0 0));border-radius:12px;padding:0;width:min(1040px,94vw);max-height:90vh;font:14px/1.55 system-ui,sans-serif}.cri-dialog::backdrop{background:oklch(15% 0 0 / .55)}.cri-head,.cri-foot{padding:18px 24px;display:flex;align-items:center;justify-content:space-between;gap:12px}.cri-head{border-bottom:1px solid var(--dsw-alias-border-l1,oklch(75% 0 0))}.cri-head h2{margin:0;font-size:20px;letter-spacing:-.02em;text-wrap:balance}.cri-main{padding:20px 24px;max-height:65vh;overflow:auto;display:grid;gap:20px}.cri-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:24px}.cri-stack{display:grid;gap:12px;align-content:start}.cri-field{display:grid;gap:5px;font-weight:550}.cri-input,.cri-button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,oklch(65% 0 0));border-radius:6px;background:var(--dsw-alias-bg-base,oklch(98% 0 0));padding:8px 10px;min-width:0}.cri-button{cursor:pointer}.cri-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,oklch(92% 0 0))}.cri-button[data-primary]{background:var(--dsw-alias-brand-primary,oklch(45% .15 260));color:oklch(100% 0 0);border-color:transparent}.cri-button:disabled{opacity:.5;cursor:not-allowed}.cri-dialog :focus-visible,.cri-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,oklch(45% .15 260));outline-offset:3px}.cri-row{display:flex;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1,oklch(80% 0 0));overflow-wrap:anywhere}.cri-row input{margin-top:5px}.cri-row small{display:block;font-weight:400}.cri-list{max-height:310px;overflow:auto}.cri-muted{color:var(--dsw-alias-label-secondary,oklch(40% .01 250));font-size:13px;margin:0;max-width:72ch}.cri-inline{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.cri-section{margin:0;font-size:15px}.cri-notice{padding:10px 12px;background:var(--dsw-alias-bg-layer-2,oklch(94% 0 0));border-radius:6px;overflow-wrap:anywhere}.cri-error{color:var(--dsw-alias-state-error-primary,oklch(43% .18 25))}.cri-previews{display:grid;gap:10px}.cri-previews details{border-bottom:1px solid var(--dsw-alias-border-l1,oklch(75% 0 0));padding:8px 0}.cri-previews summary{cursor:pointer;font-weight:600}.cri-previews pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;max-height:280px;overflow:auto}.cri-foot{border-top:1px solid var(--dsw-alias-border-l1,oklch(75% 0 0));flex-wrap:wrap}.cri-action{font:inherit;color:inherit;background:transparent;border:0;padding:6px 10px;cursor:pointer}.cri-progress{width:100%;accent-color:var(--dsw-alias-brand-primary,oklch(45% .15 260))}@media(max-width:720px){.cri-grid{grid-template-columns:1fr}.cri-main,.cri-head,.cri-foot{padding:16px}.cri-main{max-height:68vh}}@media(prefers-reduced-motion:no-preference){.cri-button{transition:background-color 150ms ease-out}}\n";
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  const units=['B','KiB','MiB','GiB','TiB']; let value=bytes, index=0;
  while(value>=1024 && index<units.length-1){value/=1024;index++;}
  return (index ? value.toFixed(1) : String(value))+' '+units[index];
}
function formatActivity(value) {
  if(value === undefined || value === null || value === '') return '活动时间未知';
  const date=new Date(value);
  return Number.isFinite(date.getTime()) ? '最后活动 '+date.toLocaleString() : '活动时间未知';
}
function formatStats(stats={},mode='summary') {
  const count=value=>Number.isInteger(value) && value>=0 ? value : '未知';
  return '总轮数 '+count(stats.totalTurns)+' · 保留 '+count(stats.keptTurns)+' · '+(mode==='summary'?'早期历史摘要 ':'丢弃早期历史 ')+count(stats.olderTurns);
}
async function refreshNativeDirectory(sessions,expectedIds=[]) {
  if(typeof sessions?.refresh!=='function' || typeof sessions.list?.getSnapshot!=='function') throw new Error('DSH 原生目录刷新接口不可用');
  await sessions.refresh();
  const snapshot=sessions.list.getSnapshot();
  if(!Array.isArray(snapshot?.ids) || (snapshot.phase !== undefined && snapshot.phase !== 'ready')) throw new Error('DSH 原生目录尚未就绪');
  if(expectedIds.some(id=>!snapshot.ids.includes(id))) throw new Error('原生目录尚未包含已导入会话');
}
function createController(request, timers = globalThis, hooks = {}) {
  let state = {capabilities:null,codexHome:'',activeCodexHome:'',sourceRootChosen:false,sourceDirty:false,sourceBlocked:false,sourceDiscovery:null,scanCompleted:false,sessions:[], workspaces:[], targets:[], selected:[], source:'', query:'', target:'', options:{keepTurns:30, historyMode:'summary', toolOutputChars:8000, presentation:'readable'}, previews:[], batchId:null, limits:{maxPreviews:24,maxPreviewBytes:64*1024*1024}, busy:false, phase:'', error:'', job:null, open:false,directoryBusy:false,directoryStatus:'',directoryError:'',imports:[],inspectedImport:'',detail:null,detailRef:null,detailBusy:false,detailError:''};
  let listeners = new Set(), revision = 0, alive = true, timer = null, abort = null, pollRevision = 0;
  const emit = patch => { state = {...state,...patch}; if (alive) for (const fn of listeners) fn(); };
  let detailAbort = null, detailTicket = 0;
  function closeDetails() {
    detailTicket++; detailAbort?.abort(); detailAbort=null;
    emit({detail:null,detailRef:null,detailBusy:false,detailError:''});
  }
  async function inspectDetails(reference, offset=0) {
    if (!alive) return;
    const ref=reference || state.detailRef;
    if (!ref || (typeof ref.previewId !== 'string' && typeof ref.importedId !== 'string')) return;
    const binding=typeof ref.previewId === 'string' ? {previewId:ref.previewId} : {importedId:ref.importedId};
    if (!Number.isSafeInteger(offset) || offset<0) return;
    detailAbort?.abort();
    const controller=new AbortController(), ticket=++detailTicket;
    detailAbort=controller;
    emit({detail:null,detailRef:binding,detailBusy:true,detailError:''});
    try {
      const data=await request('details',{...binding,offset,limit:10},controller.signal);
      if (!alive || ticket!==detailTicket || controller.signal.aborted) return;
      if (!data.detail || !Array.isArray(data.detail.records)) throw new Error('历史详情响应无效');
      emit({detail:data.detail});
    } catch(e) {
      if (!alive || ticket!==detailTicket || controller.signal.aborted) return;
      const messages={SOURCE_UNAVAILABLE:'原始来源不可用，无法核查；请确认来源文件仍在原位置。',SOURCE_CHANGED:'原始来源已变化，与已绑定快照不一致，无法核查。',PREVIEW_EXPIRED:'预览已过期，请重新进行本地预览后核查。'};
      emit({detailError:(messages[e.code] || ('历史详情读取失败：'+e.message))+' 已导入数据不受影响；不要重新导入。'});
    } finally {
      if (alive && ticket===detailTicket) { detailAbort=null; emit({detailBusy:false}); }
    }
  }
  const invalidate = patch => { revision++; closeDetails(); emit({previews:[],batchId:null,error:'',...patch}); };
  const stopTimer = () => { if (timer !== null) timers.clearTimeout(timer); timer = null; };
  const selectedRows = () => state.sessions.filter(s => state.selected.includes(s.id));
  const visible = () => state.sessions.filter(s => (!state.source || s.cwd === state.source) && String(s.title || '').toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
  const optionsValid = () => Number.isInteger(state.options.keepTurns) && state.options.keepTurns >= 1 && state.options.keepTurns <= 500 && Number.isInteger(state.options.toolOutputChars) && state.options.toolOutputChars >= 256 && state.options.toolOutputChars <= 64000 && ['summary','truncate'].includes(state.options.historyMode) && ['readable','audit'].includes(state.options.presentation);
  const readableReady = () => Array.isArray(state.capabilities?.presentations) && state.capabilities.presentations.includes('readable') && state.capabilities.adaptationVersion === 'readable-v2' && state.capabilities.details === true;
  const backendReady = () => state.options.presentation === 'audit' || readableReady();
  const sourceRootRequired = () => !!state.activeCodexHome || state.sourceRootChosen || state.sourceBlocked;
  const sourceReady = () => !state.sourceBlocked && !state.sourceDirty && state.sourceDiscovery?.found !== false;
  const capacityValid = () => state.selected.length <= state.limits.maxPreviews;
  const estimateBound = p => typeof p.source?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(p.source.sha256) && typeof p.modelUsage?.modelKey === 'string' && p.modelUsage.modelKey.trim().length>0;
  const canConfirmSummary = () => !state.busy && sourceReady() && backendReady() && !!state.batchId && capacityValid() && state.previews.length===state.selected.length && state.previews.some(p=>p.needsSummaryConfirmation) && state.previews.filter(p=>p.needsSummaryConfirmation).every(estimateBound);
  const canStart = () => !state.busy && sourceReady() && backendReady() && capacityValid() && !!state.target && state.targets.some(t => t.id === state.target) && state.selected.length > 0 && state.previews.length === state.selected.length && state.previews.every(p => p.previewId && !p.needsSummaryConfirmation && state.selected.includes(p.sessionId));
  async function scan(applySource = false) {
    if (state.busy) return;
    const codexHome=applySource ? state.codexHome.trim() : state.activeCodexHome;
    if ((applySource || sourceRootRequired()) && state.capabilities?.sourceRoot !== true) { invalidate({error:SOURCE_NOT_READY}); return; }
    const sourceRootChosen=applySource || state.sourceRootChosen;
    const previousPath=state.sourceDiscovery?.path;
    const pendingDraft=state.sourceDirty && !applySource;
    const changing=applySource;
    invalidate({busy:true,sourceDiscovery:null,...(changing ? {sessions:[],workspaces:[],selected:[],source:'',query:'',inspectedImport:'',job:null} : {}),phase:'正在扫描本机 Codex 会话（不会发送模型请求）'});
    const rev = revision;
    try {
      const data = await request('sessions',{includeArchived:false,includeSubagents:false,...(sourceRootChosen ? {codexHome} : {})});
      if (!alive || rev !== revision) return;
      const discovery=data.sourceDiscovery;
      const discoveryValid=discovery && typeof discovery.found === 'boolean' && typeof discovery.path === 'string' && discovery.path.trim().length>0 && ['manual','environment','default'].includes(discovery.source);
      const sourceConfirmed=data.capabilities?.sourceRoot === true && discoveryValid && (!sourceRootChosen || (codexHome ? discovery.found === true && discovery.source === 'manual' : discovery.source !== 'manual'));
      if (sourceRootChosen && !sourceConfirmed) {
        invalidate({busy:false,phase:'',capabilities:data.capabilities || null,sourceBlocked:true,sourceDirty:true,sourceDiscovery:null,scanCompleted:true,sessions:[],workspaces:[],selected:[],source:'',query:'',inspectedImport:'',job:null,error:'后台来源确认无效或能力已降级，请重启DSH后重试；未确认切换来源，未提交导入。'});
        return;
      }
      const sessions = data.sessions || [], targets = data.targets || [];
      const rootChanged=changing || (previousPath !== undefined && data.sourceDiscovery?.path !== undefined && previousPath !== data.sourceDiscovery.path);
      const limits={maxPreviews:Number.isSafeInteger(data.limits?.maxPreviews) && data.limits.maxPreviews>0 ? Math.min(100,data.limits.maxPreviews) : 24,maxPreviewBytes:Number.isSafeInteger(data.limits?.maxPreviewBytes) && data.limits.maxPreviewBytes>0 ? data.limits.maxPreviewBytes : 64*1024*1024};
      const discoveredDraft=sourceConfirmed && discovery.found && !pendingDraft ? discovery.path : null;
      emit({codexHome:discoveredDraft ?? state.codexHome,activeCodexHome:codexHome,sourceRootChosen,sourceBlocked:state.sourceBlocked && !sourceRootChosen,sourceDirty:(state.sourceBlocked && !sourceRootChosen) || pendingDraft || (discoveredDraft===null && state.codexHome.trim()!==codexHome),sourceDiscovery:data.capabilities?.sourceRoot === true ? data.sourceDiscovery || null : null,scanCompleted:true,capabilities:data.capabilities || null,sessions,imports:data.imports || [],workspaces:data.workspaces || [],targets,limits,...(rootChanged ? {source:'',query:'',inspectedImport:'',job:null} : {}),selected:rootChanged ? [] : state.selected.filter(id => sessions.some(s => s.id === id)),target:targets.some(t => t.id === state.target) ? state.target : '',error:''});
    } catch(e) { if (alive && rev === revision) emit({sessions:[],workspaces:[],selected:[],sourceDiscovery:null,scanCompleted:true,error:e.code === 'INVALID_CODEX_HOME' ? 'CODEX_HOME 目录无效或不可读取：'+e.message+'。请检查目录后重新扫描；未提交导入。' : e.message}); }
    finally { if (alive && rev === revision) emit({busy:false,phase:''}); }
  }
  async function preview(confirmSummary = false) {
    if (state.busy || !sourceReady() || !state.selected.length || !optionsValid()) return;
    if (!backendReady()) { invalidate({error:BACKEND_NOT_READY}); return; }
    if (!capacityValid()) { emit({error:'本批最多 '+state.limits.maxPreviews+' 个会话，请分批选择；未请求预览或模型。'}); return; }
    if (confirmSummary && !state.previews.some(p=>p.needsSummaryConfirmation)) return;
    if (confirmSummary && !canConfirmSummary()) { emit({error:'费用估算缺少有效快照 SHA-256 或模型标识，请重新进行本地预览；未请求模型。'}); return; }
    if (confirmSummary) emit({busy:true,phase:'正在生成已确认费用的摘要预览…',error:''});
    else invalidate({busy:true,phase:'正在准备本地预览和费用估算（不调用模型）…',job:null});
    const rev = revision, staged = confirmSummary ? state.previews : [], previews = [...staged];
    const rows = confirmSummary ? selectedRows().filter(s=>staged.some(p=>p.sessionId===s.id && p.needsSummaryConfirmation)) : selectedRows();
    abort = new AbortController();
    try {
      if (!confirmSummary) {
        const batch=await request('resetPreviews',{},abort.signal);
        if (!alive || rev !== revision) return;
        if (abort.signal.aborted) throw Object.assign(new Error('预览已停止'),{name:'AbortError'});
        if (typeof batch.batchId !== 'string' || !batch.batchId) throw new Error('预览批次无效，请重新进行本地预览。');
        const limits={maxPreviews:Number.isSafeInteger(batch.limits?.maxPreviews) && batch.limits.maxPreviews>0 ? Math.min(100,batch.limits.maxPreviews) : state.limits.maxPreviews,maxPreviewBytes:Number.isSafeInteger(batch.limits?.maxPreviewBytes) && batch.limits.maxPreviewBytes>0 ? batch.limits.maxPreviewBytes : state.limits.maxPreviewBytes};
        emit({batchId:batch.batchId,limits});
        if(!capacityValid()) throw new Error('本批最多 '+limits.maxPreviews+' 个会话，请分批；未请求预览或模型。');
      }
      for (let i = 0; i < rows.length; i++) {
        emit({phase:'正在预览 ' + (i+1) + '/' + rows.length + ' · ' + rows[i].title + (confirmSummary ? '（已确认费用，正在请求配置模型生成摘要）' : '（仅本地读取及估算，不调用模型）')});
        const estimate=staged.find(p=>p.sessionId===rows[i].id);
        const binding=confirmSummary ? {expectedSourceSha256:estimate.source.sha256,expectedModelKey:estimate.modelUsage.modelKey} : {};
        const data = await request('preview',{sessionId:rows[i].id,options:state.options,confirmSummary,batchId:state.batchId,...binding},abort.signal);
        if (!alive || rev !== revision) return;
        if (abort.signal.aborted) throw Object.assign(new Error('预览已停止'),{name:'AbortError'});
        const index=previews.findIndex(p=>p.sessionId===rows[i].id);
        const next={...data,sessionId:rows[i].id};
        if(index<0) previews.push(next); else previews[index]=next;
        emit({previews:[...previews]});
      }
      emit({phase:previews.some(p=>p.needsSummaryConfirmation) ? '本地预览已完成。请先检查每会话费用估算，再确认生成摘要；尚未请求模型。' : '预览已就绪。请逐会话检查后确认导入。'});
    } catch(e) { if (alive && rev === revision) {
      if(e.code === 'ESTIMATE_CHANGED') invalidate({busy:false,error:'历史快照或模型配置已变化，原费用估算已失效。请重新进行本地预览并确认费用；本次未授权新的模型请求。',phase:''});
      else if(e.code === 'CAPACITY_LIMIT') emit({error:'预览容量不足，请减少本批会话数、保留轮数或工具输出上限后重新预览；不会自动分批导入。',phase:''});
      else emit({error:e.name === 'AbortError' ? '已停止等待预览；服务端已发出的摘要请求可能仍会计费。' : e.message,phase:''});
    } }
    finally { if (alive && rev === revision) emit({busy:false}); abort = null; }
  }
  const directoryJobs=new Set();let directoryPromise=null;
  async function refreshDirectory(job=state.job) {
    if(directoryPromise)return directoryPromise;
    if(typeof hooks.refreshDirectory!=='function')return;
    const jobId=job?.id ?? null;
    emit({directoryBusy:true,directoryError:'',directoryStatus:'正在刷新 DSH 原生会话目录…'});
    directoryPromise=(async()=>{
      try{const ids=(job?.items || []).filter(i=>['completed','skipped'].includes(i.status)).map(i=>i.importedId).filter(id=>typeof id==='string');await hooks.refreshDirectory(ids);if(alive && (state.job?.id ?? null)===jobId)emit({directoryStatus:ids.length ? '已在 DSH 原生目录中确认导入会话。' : '已请求更新 DSH 原生会话目录，请查看目标工作区。',directoryError:''});}
      catch(e){if(alive && (state.job?.id ?? null)===jobId)emit({directoryStatus:'',directoryError:'导入数据未撤销；目录刷新失败：'+e.message+'。请重试刷新，不要重新导入。'});}
      finally{directoryPromise=null;if(alive)emit({directoryBusy:false});}
    })();
    return directoryPromise;
  }
  async function poll() {
    stopTimer();
    if (!alive || !state.open || !state.job || !state.busy) return;
    const ticket = ++pollRevision;
    try {
      const data = await request('status',{id:state.job.id});
      if (!alive || ticket !== pollRevision) return;
      const responseJob = data.job || data;
      if (!responseJob.id) throw new Error('任务响应缺少 id');
      const job={...state.job,...responseJob};
      const imported=new Map(state.imports.map(record=>[record.id,record]));
      for(const item of job.items || [])if(['completed','skipped'].includes(item.status)&&item.importedId&&!imported.has(item.importedId)){imported.set(item.importedId,{id:item.importedId,sourceId:item.sessionId,title:job.sourceTitles?.[item.sessionId] || state.sessions.find(source=>source.id===item.sessionId)?.title || item.importedId,targetWorkspaceId:job.targetWorkspaceId,targetWorkspaceTitle:job.targetWorkspaceTitle,targetWorkspacePath:job.targetWorkspacePath});}
      const done = TERMINAL.has(job.status);
      emit({job,imports:[...imported.values()],busy:!done,phase:done ? '批次已结束；已写入的会话会保留，不会自动续跑模型。' : '正在处理导入批次…',error:''});
      if(done && job.items?.some(i=>['completed','skipped'].includes(i.status)) && !directoryJobs.has(job.id)){directoryJobs.add(job.id);await refreshDirectory(job);}
      if (!done && state.open) timer = timers.setTimeout(poll,1000);
    } catch(e) { if (alive && ticket === pollRevision) emit({error:'获取进度失败：' + e.message + '。可手动刷新进度；不要重复开始。',phase:'进度连接中断'}); }
  }
  async function start() {
    if (!canStart()) return;
    emit({busy:true,phase:'正在提交已确认的导入批次…',error:''});
    try {
      const data = await request('jobs',{previewIds:state.previews.map(p => p.previewId),targetWorkspaceId:state.target});
      if (!alive) return;
      const job = data.job || data;
      if (!job.id) throw new Error('任务响应缺少 id');
      const target=state.targets.find(workspace=>workspace.id===state.target);
      emit({job:{...job,targetWorkspaceId:state.target,targetWorkspaceTitle:target?.title,targetWorkspacePath:target?.path,sourceTitles:Object.fromEntries(state.previews.map(preview=>[preview.sessionId,preview.source?.title || state.sessions.find(source=>source.id===preview.sessionId)?.title]))},previews:[]}); await poll();
    } catch(e) { if (alive) emit({busy:false,error:e.message,phase:''}); }
  }
  async function cancel() {
    closeDetails();
    if (abort) { abort.abort(); return; }
    if (!state.job || !state.busy) return;
    pollRevision++; stopTimer();
    emit({phase:'正在请求取消；已提交的写入不会撤销…'});
    try { await request('cancel',{id:state.job.id}); await poll(); }
    catch(e) { emit({error:e.message}); }
  }
  return {
    get:() => state, subscribe(fn){listeners.add(fn);return () => listeners.delete(fn);}, visible, backendReady, canStart, canConfirmSummary, capacityValid, optionsValid,
    open(){emit({open:true}); if(hooks.refreshDirectory && !state.busy)void refreshDirectory(); if (state.busy && state.job) void poll(); else if (!state.sessions.length) void scan();},
    leave(){pollRevision++;stopTimer();closeDetails();abort?.abort();emit({open:false});},
    close(){if (state.busy) return false; stopTimer(); closeDetails(); emit({open:false}); return true;},
    inspectDetails, closeDetails, nextDetails(){if(state.detail?.nextOffset != null && !state.detailBusy)return inspectDetails(null,state.detail.nextOffset);}, previousDetails(){if(state.detail && state.detail.offset>0 && !state.detailBusy)return inspectDetails(null,Math.max(0,state.detail.offset-10));},
    scan:()=>scan(), rescanSource:()=>scan(true), refreshDirectory:()=>refreshDirectory(), preview:()=>preview(false), confirmSummary:()=>preview(true), start, cancel, refreshProgress:poll,
    set(key,value){ if(key === 'inspectedImport'){closeDetails();emit({inspectedImport:value});return;} if (state.busy) return; if (key === 'codexHome') { if(String(value)!==state.codexHome) invalidate({codexHome:String(value),sourceDirty:true}); } else if (key === 'options') invalidate({options:{...state.options,...value}}); else if (['source','query','target'].includes(key)) invalidate({[key]:value}); },
    select(id){if (state.busy) return; invalidate({selected:state.selected.includes(id) ? state.selected.filter(x=>x!==id) : [...state.selected,id]});},
    selectVisible(){if (state.busy) return; invalidate({selected:[...new Set([...state.selected,...visible().map(s=>s.id)])]});},
    clear(){if (!state.busy) invalidate({selected:[]});},
    retry(){if (state.busy || !state.job) return; const failed=(state.job.items || []).filter(i=>i.status === 'failed').map(i=>i.sessionId); invalidate({selected:failed.filter(id => state.sessions.some(s=>s.id===id)),job:null,phase:'失败项已重新选择，请重新预览并确认后重试。'});},
    dispose(){closeDetails();alive=false;revision++;pollRevision++;stopTimer();abort?.abort();listeners.clear();}
  };
}
function createRequest(connection) {
  return async (route,body,signal) => {
    if (typeof connection?.rpc?.call !== 'function') throw new Error('DSH RPC 连接代理不可用，请检查插件连接依赖。');
    const result = await connection.rpc.call(CHANNEL,'codex-recent-import/'+route,body || {},signal);
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || 'DSH 连接请求失败'),{code:result?.error?.code});
    const data = result.value;
    if (data?.ok === false) throw Object.assign(new Error(data.error?.message || '导入服务请求失败'),{code:data.error?.code});
    if (!data || typeof data !== 'object') throw new Error('导入服务返回无效数据');
    return data;
  };
}
if (typeof window === 'undefined' || !window.__ModuleLoader__) return;
window.__ModuleLoader__.load({id:'dsh-codex-recent-import',factory(require){
  const React = require('react'), h=React.createElement;
  function Panel({controller,layout}) {
    const s=React.useSyncExternalStore(controller.subscribe,controller.get,controller.get);
    React.useEffect(()=>{controller.open();return ()=>controller.leave();},[controller]);
    const button=(label,fn,disabled=false,primary=false)=>h('button',{type:'button',className:'cri-button',onClick:fn,disabled,'data-primary':primary || undefined},label);
    const field=(label,child)=>h('label',{className:'cri-field'},label,child);
    const select=(label,value,items,onChange,props={})=>field(label,h('select',{className:'cri-input',value,disabled:s.busy,...props,onChange:e=>onChange(e.target.value)},...items.map(([value,title])=>h('option',{key:value,value},title))));
    const check=(label,value,fn)=>h('label',{className:'cri-inline'},h('input',{type:'checkbox',checked:value,disabled:s.busy,onChange:e=>fn(e.target.checked)}),label);
    const rows=controller.visible(), items=s.job?.items || [], finished=items.filter(i=>TERMINAL.has(i.status)).length;
    const targetMissing=!s.target || !s.targets.some(target=>target.id===s.target);
    const targetHint=s.previews.length?'请先选择目标工作区；选择后请重新预览，再确认导入。':'请先选择目标工作区，再预览并确认导入。';
    return h(React.Fragment,null,h('style',null,CSS),h('section',{className:'cri-dialog cri-page','aria-labelledby':'cri-title'},
      h('header',{className:'cri-head'},h('div',null,h('h2',{id:'cri-title'},'导入 Codex 最近会话 · v'+CLIENT_VERSION),h('p',{className:'cri-muted'},'只复制历史，不执行工具、不自动续跑；原始 Codex 数据保持不变。本地适配不生成推理。')),button('返回会话',()=>{controller.leave();layout?.selectPanel(null);})),
      h('div',{className:'cri-main','aria-busy':s.busy},
        h('div',{className:'cri-grid'},
          h('section',{className:'cri-stack','aria-label':'来源会话'},h('h3',{className:'cri-section'},'1 · 选择来源'),
            h('p',{className:s.sourceDiscovery?.found?'cri-muted':'cri-notice',role:'status'},s.sourceDiscovery ? (s.sourceDiscovery.found ? '发现方式：'+({manual:'手动指定',environment:'环境变量 CODEX_HOME',default:'默认目录'}[s.sourceDiscovery.source] || '未知') : '未找到可读取的 Codex 来源目录：'+(s.sourceDiscovery.message || '请填写 CODEX_HOME 后重新扫描。')) : (s.scanCompleted && s.capabilities?.sourceRoot !== true ? '后台未支持来源选择；当前仅兼容旧版自动扫描。手填目录需重启DSH后重试。' : '等待扫描确认实际 CODEX_HOME 目录。')),
            field('CODEX_HOME（可选更换；留空自动发现）',h('input',{type:'text',className:'cri-input',value:s.codexHome,disabled:s.busy,placeholder:'填写运行 DSH 的主机可读取的 Codex 目录',onChange:e=>controller.set('codexHome',e.target.value)})),
            h('p',{className:'cri-muted'},'目录仅在点击下方按钮后应用。Windows 可手填 WSL UNC 路径，例如 ',h('code',null,String.raw`\\wsl.localhost\Ubuntu\home\用户名\.codex`),'；插件不执行 WSL 启动命令，请先确保发行版及路径可访问。若 DSH 在 WSL 内运行，请填 Linux 路径，例如 /home/用户名/.codex。此示例未作 Windows 实机验证。'),
            button(s.sourceDirty?'应用目录并扫描':'刷新会话列表',()=>s.sourceDirty?controller.rescanSource():controller.scan(),s.busy),
            s.sourceDirty ? h('p',{className:'cri-notice'},'目录草稿待应用，旧预览已失效；请点击“应用目录并扫描”后再预览或导入。') : null,
            select('来源 workspace / worktree',s.source,[['','全部来源目录'],...s.workspaces.map(w=>[w.path,w.path+' · '+w.count+' 个会话'])],value=>controller.set('source',value)),
            field('搜索会话标题',h('input',{type:'search',className:'cri-input',value:s.query,disabled:s.busy,placeholder:'输入标题关键词',onChange:e=>controller.set('query',e.target.value)})),
            h('p',{className:'cri-muted'},'仅导入所选主会话，不导入子代理的独立对话。主日志中已有的子代理调用和返回结果仍作为历史保留；不会恢复原来的多代理运行状态。'),
            h('div',{className:'cri-inline'},button('选择筛选结果',()=>controller.selectVisible(),s.busy || !rows.length),button('清空选择',()=>controller.clear(),s.busy || !s.selected.length)),
            h('p',{className:'cri-muted'},'已选 '+s.selected.length+' 个 · 当前筛选 '+rows.length+' 个（隐藏项仍保留选择）'),h('p',{className:controller.capacityValid()?'cri-muted':'cri-error',role:controller.capacityValid()?undefined:'alert'},'本批最多 '+s.limits.maxPreviews+' 个会话，请分批；服务端预览容量 '+formatBytes(s.limits.maxPreviewBytes)+'。不会自动分批导入。'),
            h('div',{className:'cri-list'},rows.length ? rows.map(row=>h('label',{className:'cri-row',key:row.id},h('input',{type:'checkbox',checked:s.selected.includes(row.id),disabled:s.busy,onChange:()=>controller.select(row.id)}),h('span',null,row.title || '未命名会话',h('small',null,row.cwd || '未知目录'),h('small',null,formatActivity(row.updatedAt)+' · '+formatBytes(row.bytes)+' · 轮数预览后统计'),h('small',null,[row.archived?'已归档':'',row.subagent?'子代理':'',row.imported?'曾导入':''].filter(Boolean).join(' · '))))) : h('p',{className:'cri-muted'},s.busy ? '正在读取列表…' : '没有匹配的主会话。可调整搜索条件或刷新会话列表。'))),
          h('section',{className:'cri-stack','aria-label':'导入设置'},h('h3',{className:'cri-section'},'2 · 设置导入范围'),
            select('目标 DSH workspace',s.target,[['','请选择目标工作区'],...s.targets.map(t=>[t.id,t.title || t.id])],v=>controller.set('target',v),{'aria-invalid':targetMissing,'aria-describedby':targetMissing?'cri-target-required':undefined}),
            targetMissing && s.targets.length ? h('p',{id:'cri-target-required',className:'cri-error'},targetHint) : null,
            !s.targets.length ? h('p',{id:'cri-target-required',className:'cri-muted'},'暂无目标工作区，请先在 DSH 中创建或打开工作区后刷新。') : null,
            !controller.backendReady() ? h('p',{role:'alert',className:'cri-error'},BACKEND_NOT_READY) : null,
            select('历史展示方式',s.options.presentation,[['readable','阅读／续聊适配（推荐）'],['audit','完整审计']],v=>controller.set('options',{presentation:v})),
            field('保留最近用户轮数 N（1–500）',h('input',{type:'number',className:'cri-input',min:1,max:500,step:1,value:s.options.keepTurns,disabled:s.busy,onChange:e=>controller.set('options',{keepTurns:e.target.value === '' ? '' : Number(e.target.value)})})),
            select('更早历史的处理方式',s.options.historyMode,[['summary','生成早期历史摘要'],['truncate','丢弃早期历史（仅本地，不调用模型）']],v=>controller.set('options',{historyMode:v})),
            h('p',{className:'cri-notice'},s.options.historyMode === 'summary' ? '隐私与费用：首次“预览所选”只在本机读取与估算，不调用模型。随后点击“确认费用并生成摘要”才会将更早历史发送至 DSH 配置的模型供应商，可能产生费用；输入量为估算，摘要归并还可能产生额外调用。' : '截断模式：只保留最近 N 轮，更早历史不导入。不会请求摘要模型。'),
            field('每条工具输出字符上限（256–64000，保留头尾）',h('input',{type:'number',className:'cri-input',min:256,max:64000,step:1,value:s.options.toolOutputChars,disabled:s.busy,onChange:e=>controller.set('options',{toolOutputChars:e.target.value === '' ? '' : Number(e.target.value)})})),
            !controller.optionsValid() ? h('p',{role:'alert',className:'cri-error'},'请输入范围内的整数。') : null,
            h('p',{className:'cri-muted'},'修改筛选、选择、目标或参数后，原预览立即失效。导入前必须重新预览。'))),
        h('section',{className:'cri-previews','aria-label':'逐会话预览'},h('h3',{className:'cri-section'},'3 · 检查逐会话预览'),
          !s.previews.length ? h('p',{className:'cri-muted'},'点击预览后在此检查保留轮次、早期摘要、工具截断和警告；此步骤不会写入 DSH 会话。') : s.previews.map(p=>h('details',{key:p.sessionId,open:true},h('summary',null,p.source?.title || p.sessionId),h('p',{className:'cri-muted'},formatStats(p.stats,s.options.historyMode)),p.needsSummaryConfirmation ? h('p',{className:'cri-notice'},'待确认费用：输入约 '+(p.modelUsage?.inputChars ?? '未知')+' 字符 · '+(p.modelUsage?.chunks ?? '未知')+' 段 · 约 '+(p.modelUsage?.estimatedInputTokens ?? '未知')+' 输入 tokens · 模型 '+(p.modelUsage?.modelKey || 'DSH 配置模型')+'。尚未发送模型请求。') : null,h('details',null,h('summary',null,'统计与模型用量详情'),h('pre',null,JSON.stringify({stats:p.stats || {},adaptation:p.adaptation || {},modelUsage:p.modelUsage || {}},null,2))),...(p.warnings || []).map((w,i)=>h('p',{className:'cri-notice',key:i},String(w))),p.previewId ? button('核查原始历史（只读）',()=>controller.inspectDetails({previewId:p.previewId}),s.detailBusy) : null,p.adaptation ? h('details',null,h('summary',null,'适配统计与前后片段'),h('pre',null,JSON.stringify(p.adaptation,null,2))) : null,p.summary ? h('pre',null,p.summary) : null,h('pre',null,typeof p.turnsPreview === 'string' ? p.turnsPreview : JSON.stringify(p.turnsPreview || [],null,2))))),
        h('section',{className:'cri-previews','aria-label':'已导入会话列表'},h('h3',{className:'cri-section'},'已导入会话 · '+s.imports.length),
          s.imports.length ? h('ul',{className:'cri-list',style:{listStyle:'none',padding:0,margin:0}},...s.imports.map(record=>{const workspace=s.targets.find(target=>target.id===record.targetWorkspaceId);const name=workspace?.title || record.targetWorkspaceTitle;const path=workspace?.path || record.targetWorkspacePath;return h('li',{className:'cri-row',key:record.id},h('span',null,h('strong',null,record.title || record.id),h('small',null,'导入工作区：'+(name || path || ('未取得名称（ID：'+(record.targetWorkspaceId || '未知')+'）'))),name && path && path!==name ? h('small',null,path) : null));})) : h('p',{className:'cri-muted'},'暂无导入记录。')),
        s.detailRef ? h('section',{className:'cri-previews','aria-label':'来源详情','aria-busy':s.detailBusy},h('h4',null,'原始历史详情（只读）'),
            s.detailBusy ? h('p',{role:'status'},'正在本机读取详情…') : null,
            s.detailError ? h('p',{className:'cri-error',role:'alert'},s.detailError) : null,
            s.detail ? h(React.Fragment,null,h('h4',null,s.detail.source?.title || '历史来源'),h('pre',null,JSON.stringify({source:s.detail.source,presentation:s.detail.presentation,version:s.detail.version,stats:s.detail.stats},null,2)),
              ...(s.detail.warnings || []).map((w,i)=>h('p',{key:i,className:'cri-notice'},String(w))),
              ...s.detail.records.map(r=>h('div',{key:r.index},h('p',null,'记录 '+r.index+(r.truncated?' · 已截断（非完整记录）':'')),h('pre',null,String(r.text ?? '')))),
              h('p',null,'偏移 '+s.detail.offset+' · 总记录 '+s.detail.total),
              button('上一页',()=>controller.previousDetails(),s.detailBusy || s.detail.offset<=0),button('下一页',()=>controller.nextDetails(),s.detailBusy || s.detail.nextOffset==null)) : null,
            button(s.detailBusy?'取消读取详情':'关闭详情',()=>controller.closeDetails())) : null,
        s.phase ? h('div',{role:'status','aria-live':'polite',className:'cri-notice'},s.phase) : null,
        s.error ? h('div',{role:'alert',className:'cri-error'},s.error) : null,
        s.directoryError ? h('p',{role:'alert',className:'cri-error'},s.directoryError) : null,
        button(s.directoryBusy?'正在刷新 DSH 会话列表…':'刷新 DSH 会话列表（不重新导入）',()=>controller.refreshDirectory(),s.busy || s.directoryBusy),
        s.job ? h('section',{className:'cri-stack','aria-label':'导入进度'},h('h3',{className:'cri-section'},'批次进度 · '+finished+'/'+items.length),h('progress',{className:'cri-progress',value:finished,max:Math.max(1,items.length),'aria-label':'已结束会话数'}),...items.map((item,i)=>h('div',{className:'cri-row',key:i},h('span',null,(s.sessions.find(r=>r.id===item.sessionId)?.title || item.sessionId || '会话')+' · '+(LABELS[item.status] || item.status),item.error ? h('small',{className:'cri-error'},typeof item.error === 'string' ? item.error : item.error.message) : null,item.warning ? h('small',null,String(item.warning)) : null))),button('刷新任务进度',()=>controller.refreshProgress()),!s.busy && items.some(i=>i.status==='failed') ? button('重新选择失败项',()=>controller.retry()) : null) : null),
      h('footer',{className:'cri-foot'},h('span',{className:!s.busy && targetMissing?'cri-error':'cri-muted',role:'status'},s.busy ? '正在处理，请勿重复开始；已写入会话不会因取消而删除。' : targetMissing ? (s.targets.length?targetHint:'暂无目标工作区，请先在 DSH 中创建或打开工作区后刷新。') : '确认开始后才写入目标工作区；重复导入将由服务端明确跳过。'),h('div',{className:'cri-inline'},s.busy ? button(s.job?'取消剩余任务':'停止等待预览',()=>controller.cancel(),!s.job && !s.phase.includes('预览')) : null,button('预览所选（本地，无模型费用）',()=>controller.preview(),s.busy || !s.selected.length || !controller.optionsValid() || !controller.capacityValid()),s.previews.some(p=>p.needsSummaryConfirmation) ? button('确认费用并生成摘要',()=>controller.confirmSummary(),!controller.canConfirmSummary()) : null,button('确认并开始导入',()=>controller.start(),!controller.canStart(),true)))));
  }
  function apply(ctx){
    const controller=createController(createRequest(ctx.connection),globalThis,{refreshDirectory:ids=>refreshNativeDirectory(ctx.sessions,ids)});
    ctx.effect(()=>()=>controller.dispose(),'codex-recent-import: dispose');
    const layout={selectPanel(id){const service=typeof ctx.get==='function' ? ctx.get('layout') : ctx.layout;service?.selectPanel?.(id);}};
    ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'codex-recent-import',order:7,label:()=> 'Codex 会话导入'},({size=16})=>h('svg',{width:size,height:size,viewBox:'0 0 16 16',fill:'none','aria-hidden':true},h('path',{d:'M2.5 4V3.5A1.5 1.5 0 0 1 4 2h8a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 11H8l-3.5 3v-3H4a1.5 1.5 0 0 1-1.5-1.5V9M1.5 6.5h7M6 4l2.5 2.5L6 9',stroke:'currentColor',strokeWidth:1.5,strokeLinecap:'round',strokeLinejoin:'round'}))));
    ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'codex-recent-import',inject:()=>({controller,layout})},Panel));
  }
  return {inject:['slots','connection','sessions','layout'],apply};
}});
})();
