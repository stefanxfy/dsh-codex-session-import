/* Original implementation. Host integration follows the public DSH ModuleLoader/slots API. */
(function () {
'use strict';
const CHANNEL = '/api';
const CLIENT_VERSION = '0.1.28';
const SOURCE_NOT_READY = '后台未支持来源选择，请重启DSH后重试；未提交目录扫描或导入';
const BACKEND_NOT_READY = '后台尚未加载阅读适配或版本不匹配（需 readable-v2），请重启DSH；未提交导入';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const LABELS = {queued:'等待处理', preparing:'正在准备', summarizing:'AI摘要已停用', validating:'正在验证', writing:'正在写入', completed:'已完成', failed:'失败', skipped:'重复，已跳过', cancelled:'已取消', running:'正在处理', cancelling:'正在取消'};
const CSS = "/* Codex import: native product workbench. Host owns the outer height. */\n.cri-dialog {\n  --cri-bg: var(--dsw-alias-bg-overlay, oklch(99% .002 250));\n  --cri-subtle: var(--dsw-alias-bg-layer-2, oklch(96% .004 250));\n  --cri-input: var(--dsw-alias-bg-base, oklch(100% 0 0));\n  --cri-ink: var(--dsw-alias-label-primary, oklch(26% .012 250));\n  --cri-muted: var(--dsw-alias-label-secondary, color-mix(in oklch, var(--cri-ink) 72%, var(--cri-bg)));\n  --cri-line: var(--dsw-alias-border-l1, oklch(85% .008 250));\n  --cri-accent: var(--dsw-alias-brand-primary, oklch(47% .10 253));\n  --cri-selected: var(--dsw-alias-bg-brand, color-mix(in oklch, var(--cri-accent) 12%, var(--cri-bg)));\n  --cri-on-accent: var(--dsw-alias-label-on-primary, var(--cri-bg));\n  --cri-error: var(--dsw-alias-state-error-primary, color-mix(in oklch, var(--cri-ink) 70%, oklch(55% .22 25)));\n  box-sizing: border-box;\n  color: var(--cri-ink);\n  background: var(--cri-bg);\n  border: 1px solid var(--cri-line);\n  border-radius: 8px;\n  padding: 0;\n  width: min(1280px, 96vw);\n  max-height: 90vh;\n  font: 14px/1.5 -apple-system, BlinkMacSystemFont, \"Segoe UI\", system-ui, sans-serif;\n}\n\n.cri-dialog *,\n.cri-dialog *::before,\n.cri-dialog *::after {\n  box-sizing: border-box;\n}\n\n.cri-dialog::backdrop {\n  background: oklch(20% .008 250 / .45);\n}\n\n.cri-dialog.cri-page {\n  display: flex;\n  flex-direction: column;\n  width: 100%;\n  height: 100%;\n  min-width: 0;\n  min-height: 0;\n  max-height: none;\n  border: 0;\n  border-radius: 0;\n  container: cri-page / inline-size;\n}\n\n.cri-head,\n.cri-foot {\n  display: flex;\n  flex: 0 0 auto;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px 20px;\n  padding: 16px 20px;\n  background: var(--cri-bg);\n}\n\n.cri-head {\n  border-bottom: 1px solid var(--cri-line);\n}\n\n.cri-head > div,\n.cri-foot > span {\n  min-width: 0;\n  overflow-wrap: anywhere;\n}\n\n.cri-head h2 {\n  margin: 0;\n  font-size: 20px;\n  font-weight: 650;\n  line-height: 1.35;\n  letter-spacing: -.02em;\n  text-wrap: balance;\n}\n\n.cri-head .cri-muted {\n  margin-top: 5px;\n}\n\n.cri-title-line,\n.cri-inline,\n.cri-toolbar {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 8px;\n  min-width: 0;\n}\n\n.cri-version {\n  color: var(--cri-muted);\n  font-size: 12px;\n  font-weight: 400;\n}\n\n.cri-main {\n  display: grid;\n  align-content: start;\n  gap: 16px;\n  padding: 20px;\n  min-width: 0;\n  max-height: 65vh;\n  overflow: auto;\n}\n\n.cri-page .cri-main {\n  display: flex;\n  flex: 1 1 0;\n  flex-direction: column;\n  min-height: 0;\n  max-height: none;\n}\n\n.cri-grid {\n  display: grid;\n  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);\n  gap: 24px;\n  min-width: 0;\n}\n\n/* min-height:0 is intentional at every constrained flex/grid boundary.\n   Main remains an overflow fallback if global alerts consume the pane area. */\n.cri-workbench {\n  display: grid;\n  flex: 1 0 280px;\n  grid-template-columns: minmax(220px, .8fr) minmax(300px, 1.5fr) minmax(280px, .95fr);\n  grid-template-rows: minmax(0, 1fr);\n  min-width: 0;\n  min-height: 0;\n  border: 1px solid var(--cri-line);\n  border-radius: 6px;\n  background: var(--cri-bg);\n}\n\n.cri-pane {\n  display: flex;\n  flex-direction: column;\n  min-width: 0;\n  min-height: 0;\n}\n\n.cri-source-pane .cri-field {\n  font-size: 12px;\n}\n\n.cri-preview-pane .cri-pane-body {\n  gap: 16px;\n}\n\n.cri-pane + .cri-pane {\n  border-left: 1px solid var(--cri-line);\n}\n\n.cri-pane-head {\n  display: flex;\n  flex: 0 0 auto;\n  align-items: center;\n  justify-content: space-between;\n  flex-wrap: wrap;\n  gap: 8px;\n  min-width: 0;\n  padding: 14px 16px;\n  border-bottom: 1px solid var(--cri-line);\n}\n\n.cri-pane-body {\n  display: flex;\n  flex: 1 1 0;\n  flex-direction: column;\n  gap: 12px;\n  min-width: 0;\n  min-height: 0;\n  padding: 16px;\n  overflow: auto;\n  overflow-wrap: anywhere;\n  scrollbar-gutter: stable;\n}\n\n.cri-pane-body > * {\n  flex-shrink: 0;\n  min-width: 0;\n  max-width: 100%;\n}\n\n.cri-stack {\n  display: grid;\n  align-content: start;\n  gap: 12px;\n  min-width: 0;\n}\n\n.cri-field {\n  display: grid;\n  gap: 6px;\n  min-width: 0;\n  font-weight: 550;\n  overflow-wrap: anywhere;\n}\n\n.cri-input,\n.cri-button {\n  min-width: 0;\n  max-width: 100%;\n  min-height: 36px;\n  padding: 7px 10px;\n  border: 1px solid var(--cri-line);\n  border-radius: 5px;\n  color: inherit;\n  background: var(--cri-input);\n  font: inherit;\n  line-height: 1.4;\n}\n\n.cri-input {\n  width: 100%;\n}\n\n.cri-input::placeholder {\n  color: var(--cri-muted);\n  opacity: 1;\n}\n\n.cri-input[aria-invalid=\"true\"] {\n  border-color: var(--cri-error);\n}\n\n.cri-button {\n  cursor: pointer;\n  white-space: normal;\n  overflow-wrap: anywhere;\n}\n\n.cri-button:hover:not(:disabled),\n.cri-action:hover:not(:disabled) {\n  background: var(--cri-subtle);\n}\n\n.cri-button[data-primary] {\n  border-color: var(--cri-accent);\n  color: var(--cri-on-accent);\n  background: var(--cri-accent);\n}\n\n.cri-button[data-primary]:hover:not(:disabled) {\n  background: var(--cri-accent);\n  filter: brightness(1.08);\n}\n\n.cri-dialog :disabled {\n  cursor: not-allowed;\n  opacity: .5;\n}\n\n.cri-dialog :focus-visible,\n.cri-action:focus-visible {\n  outline: 2px solid var(--cri-accent);\n  outline-offset: 2px;\n}\n\n.cri-dialog input[type=\"checkbox\"],\n.cri-dialog input[type=\"radio\"] {\n  flex: 0 0 auto;\n  width: 16px;\n  height: 16px;\n  accent-color: var(--cri-accent);\n}\n\n.cri-row {\n  display: flex;\n  align-items: start;\n  gap: 10px;\n  min-width: 0;\n  padding: 12px 0;\n  border-bottom: 1px solid var(--cri-line);\n  overflow-wrap: anywhere;\n}\n\n.cri-row > span,\n.cri-row-main {\n  flex: 1 1 0;\n  min-width: 0;\n  overflow-wrap: anywhere;\n}\n\n.cri-row input {\n  margin: 3px 0 0;\n}\n\n.cri-row small {\n  display: block;\n  margin-top: 4px;\n  color: var(--cri-muted);\n  font-size: 12px;\n  font-weight: 400;\n}\n\n.cri-list {\n  min-width: 0;\n  max-height: 310px;\n  overflow: auto;\n}\n\n.cri-source-list {\n  flex: 1 0 180px;\n  min-height: 180px;\n  max-height: none;\n  overflow: auto;\n}\n\n.cri-source-row {\n  padding: 12px 10px;\n  cursor: pointer;\n  border-radius: 4px;\n}\n\n.cri-source-row:hover {\n  background: var(--cri-subtle);\n}\n\n.cri-row:has(input:checked),\n.cri-source-row[aria-selected=\"true\"] {\n  background: var(--cri-selected);\n}\n\n.cri-row:has(input:focus-visible) {\n  outline: 2px solid var(--cri-accent);\n  outline-offset: -2px;\n}\n\n.cri-row:has(input:disabled) {\n  cursor: not-allowed;\n}\n\n.cri-muted,\n.cri-selected-count {\n  max-width: 72ch;\n  margin: 0;\n  color: var(--cri-muted);\n  font-size: 12px;\n  overflow-wrap: anywhere;\n}\n\n.cri-selected-count {\n  font-variant-numeric: tabular-nums;\n}\n\n.cri-section {\n  margin: 0;\n  font-size: 14px;\n  font-weight: 650;\n}\n\n.cri-notice {\n  margin: 0;\n  padding: 10px 12px;\n  border: 1px solid var(--cri-line);\n  border-radius: 5px;\n  background: var(--cri-subtle);\n  overflow-wrap: anywhere;\n}\n\n.cri-error,\n.cri-row small.cri-error {\n  color: var(--cri-error);\n  overflow-wrap: anywhere;\n}\n\n.cri-global-status {\n  flex: 0 0 auto;\n  min-width: 0;\n  max-height: 30vh;\n  overflow: auto;\n}\n\n.cri-global-status:empty {\n  display: none;\n}\n\n.cri-previews {\n  display: grid;\n  align-content: start;\n  gap: 12px;\n  min-width: 0;\n}\n\n.cri-previews details,\n.cri-config-details,\n.cri-platform-details {\n  min-width: 0;\n  padding: 10px 0;\n  border-bottom: 1px solid var(--cri-line);\n  overflow-wrap: anywhere;\n}\n\n.cri-dialog summary {\n  cursor: pointer;\n  font-weight: 600;\n  overflow-wrap: anywhere;\n}\n\n.cri-config-details[open] > :not(summary),\n.cri-platform-details[open] > :not(summary),\n.cri-preview-card[open] > :not(summary) {\n  margin-top: 12px;\n}\n\n.cri-preview-card {\n  min-width: 0;\n  padding-bottom: 16px;\n  border-bottom: 1px solid var(--cri-line);\n}\n\n.cri-preview-stats {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 12px 24px;\n  padding: 12px 0;\n  border-bottom: 1px solid var(--cri-line);\n}\n\n.cri-preview-stat {\n  display: flex;\n  flex-direction: column;\n  gap: 3px;\n  min-width: 0;\n  color: var(--cri-muted);\n  font-size: 12px;\n}\n\n.cri-preview-stat strong {\n  color: var(--cri-ink);\n  font-size: 20px;\n  font-weight: 600;\n  font-variant-numeric: tabular-nums;\n}\n\n.cri-dialog pre,\n.cri-turn-preview {\n  max-width: 100%;\n  max-height: 320px;\n  margin: 10px 0 0;\n  padding: 12px;\n  border: 1px solid var(--cri-line);\n  border-radius: 4px;\n  background: var(--cri-subtle);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  word-break: break-word;\n  overflow: auto;\n  font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace;\n}\n\n.cri-dialog code {\n  overflow-wrap: anywhere;\n}\n\n.cri-empty-state {\n  display: flex;\n  flex: 1 0 220px;\n  flex-direction: column;\n  justify-content: center;\n  align-items: center;\n  gap: 10px;\n  min-width: 0;\n  padding: 28px 16px;\n  color: var(--cri-muted);\n  text-align: center;\n  overflow-wrap: anywhere;\n}\n\n.cri-empty-state strong {\n  color: var(--cri-ink);\n  font-weight: 600;\n}\n\n.cri-empty-state p {\n  max-width: 48ch;\n  margin: 0;\n}\n\n.cri-detail-panel,\n.cri-batch-progress {\n  min-width: 0;\n  padding-top: 16px;\n  border-top: 1px solid var(--cri-line);\n  overflow-wrap: anywhere;\n}\n\n.cri-foot {\n  flex-wrap: wrap;\n  border-top: 1px solid var(--cri-line);\n}\n\n.cri-foot > span {\n  flex: 1 1 240px;\n}\n\n.cri-foot > .cri-inline {\n  justify-content: flex-end;\n  margin-left: auto;\n}\n\n.cri-action {\n  min-height: 36px;\n  padding: 7px 10px;\n  border: 0;\n  border-radius: 5px;\n  color: inherit;\n  background: transparent;\n  font: inherit;\n  cursor: pointer;\n}\n\n.cri-progress {\n  width: 100%;\n  height: 8px;\n  accent-color: var(--cri-accent);\n}\n\n/* Container queries follow the actual host panel, not just browser width. */\n@container cri-page (max-width: 1100px) {\n  .cri-workbench {\n    flex: 0 0 auto;\n    grid-template-columns: minmax(220px, .8fr) minmax(300px, 1.5fr);\n    grid-template-rows: minmax(360px, 55vh) auto;\n  }\n  .cri-settings-pane {\n    grid-column: 1 / -1;\n    border-left: 0 !important;\n    border-top: 1px solid var(--cri-line);\n  }\n  .cri-settings-pane .cri-pane-body {\n    flex-basis: auto;\n    overflow: visible;\n  }\n}\n\n@container cri-page (max-width: 700px) {\n  .cri-head, .cri-foot { padding: 12px; }\n  .cri-head { align-items: flex-start; }\n  .cri-main { padding: 12px; gap: 12px; }\n  .cri-grid { grid-template-columns: minmax(0, 1fr); }\n  .cri-workbench { display: flex; flex-direction: column; }\n  .cri-pane + .cri-pane {\n    border-left: 0;\n    border-top: 1px solid var(--cri-line);\n  }\n  .cri-pane-body { flex-basis: auto; overflow: visible; }\n  .cri-source-list { flex-basis: auto; max-height: 320px; }\n  .cri-pane-head, .cri-pane-body { padding: 12px; }\n  .cri-foot > .cri-inline { width: 100%; }\n  .cri-foot .cri-button { flex: 1 1 140px; }\n}\n\n/* Viewport fallback for hosts without container-query support. */\n@supports not (container-type: inline-size) {\n  @media (max-width: 1100px) {\n    .cri-workbench {\n      flex: 0 0 auto;\n      grid-template-columns: minmax(220px, .8fr) minmax(300px, 1.5fr);\n      grid-template-rows: minmax(360px, 55vh) auto;\n    }\n    .cri-settings-pane { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--cri-line); }\n    .cri-settings-pane .cri-pane-body { flex-basis: auto; overflow: visible; }\n  }\n  @media (max-width: 700px) {\n    .cri-head, .cri-foot { padding: 12px; }\n    .cri-main { padding: 12px; }\n    .cri-grid { grid-template-columns: minmax(0, 1fr); }\n    .cri-workbench { display: flex; flex-direction: column; }\n    .cri-pane + .cri-pane { border-left: 0; border-top: 1px solid var(--cri-line); }\n    .cri-pane-body { flex-basis: auto; overflow: visible; }\n    .cri-source-list { flex-basis: auto; max-height: 320px; }\n    .cri-foot > .cri-inline { width: 100%; }\n  }\n}\n\n/* Dark fallbacks are overridden by the same native aliases when available. */\n@media (prefers-color-scheme: dark) {\n  .cri-dialog {\n    --cri-bg: var(--dsw-alias-bg-overlay, oklch(23% .010 250));\n    --cri-subtle: var(--dsw-alias-bg-layer-2, oklch(27% .010 250));\n    --cri-input: var(--dsw-alias-bg-base, oklch(21% .008 250));\n    --cri-ink: var(--dsw-alias-label-primary, oklch(93% .006 250));\n    --cri-muted: var(--dsw-alias-label-secondary, oklch(75% .012 250));\n    --cri-line: var(--dsw-alias-border-l1, oklch(39% .014 250));\n    --cri-accent: var(--dsw-alias-brand-primary, oklch(72% .085 253));\n    --cri-selected: var(--dsw-alias-bg-brand, oklch(31% .038 253));\n    --cri-on-accent: var(--dsw-alias-label-on-primary, oklch(20% .012 250));\n    --cri-error: var(--dsw-alias-state-error-primary, oklch(78% .12 25));\n  }\n}\n\n@media (prefers-reduced-motion: no-preference) {\n  .cri-button, .cri-action, .cri-source-row {\n    transition: background-color 150ms ease-out;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .cri-dialog *, .cri-dialog *::before, .cri-dialog *::after {\n    scroll-behavior: auto !important;\n    transition: none !important;\n    animation: none !important;\n  }\n}\n\n/* B reference restoration: distinct surfaces, quiet controls and readable metrics. */\n.cri-dialog {\n  --cri-surface: var(--dsw-alias-bg-base, Canvas);\n  --cri-bg: color-mix(in oklch, var(--cri-surface) 97%, var(--cri-ink));\n  --cri-subtle: color-mix(in oklch, var(--cri-surface) 94%, var(--cri-ink));\n  --cri-selected: color-mix(in oklch, var(--cri-accent) 12%, var(--cri-surface));\n}\n.cri-head, .cri-foot, .cri-workbench, .cri-pane-head, .cri-source-pane, .cri-settings-pane { background: var(--cri-surface); }\n.cri-preview-pane { background: var(--cri-bg); }\n.cri-head h2 { font-size: 18px; font-weight: 600; }\n.cri-pane-head { padding: 13px 16px; }\n.cri-pane-body { gap: 12px; }\n.cri-input, .cri-button { font-size: 13px; font-weight: 400; padding: 6px 10px; }\n.cri-field { font-size: 12px; font-weight: 600; }\n.cri-source-pane .cri-pane-body { padding: 14px 12px; }\n.cri-source-row { padding: 9px 8px; margin: 2px 0; border-bottom: 0; font-weight: 500; }\n.cri-source-row small { font-size: 11px; line-height: 1.45; margin-top: 3px; }\n.cri-source-row small:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.cri-preview-card { padding: 0 0 16px; }\n.cri-preview-card > summary { font-size: 13px; font-weight: 600; }\n.cri-preview-stats { gap: 16px 26px; border-bottom: 0; padding: 10px 0 2px; }\n.cri-preview-stat { font-size: 11px; line-height: 1.45; gap: 2px; }\n.cri-preview-stat strong { font-size: 17px; font-weight: 600; }\n.cri-config-details > summary, .cri-platform-details > summary { font-size: 12px; }\n.cri-notice { font-size: 12px; line-height: 1.6; }\n@container cri-page (min-width: 1101px) {\n  .cri-workbench { grid-template-columns: minmax(215px,.8fr) minmax(280px,1.5fr) minmax(250px,1fr); }\n}\n\n/* Keep B's blue identity even when the host brand color is monochrome. */\n.cri-dialog {\n  --cri-accent: oklch(48% .10 253);\n  --cri-on-accent: oklch(99% 0 0);\n  --cri-muted: color-mix(in oklch, var(--cri-ink) 72%, var(--cri-surface));\n  --cri-error: var(--dsw-alias-state-error-primary, color-mix(in oklch, var(--cri-ink) 70%, oklch(55% .22 25)));\n}\n@supports (color: oklch(from white l c h)) {\n  .cri-dialog {\n    --cri-accent: oklch(from var(--cri-surface) calc(.78 - l * .30) .10 253);\n    --cri-on-accent: var(--cri-surface);\n  }\n}\n";
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
function formatStats(stats={},mode='truncate') {
  const count=value=>Number.isInteger(value) && value>=0 ? value : '未知';
  return '总轮数 '+count(stats.totalTurns)+' · 保留 '+count(stats.keptTurns)+' · '+'丢弃早期历史 '+count(stats.olderTurns);
}
async function refreshNativeDirectory(sessions,expectedIds=[]) {
  if(typeof sessions?.refresh!=='function' || typeof sessions.list?.getSnapshot!=='function') throw new Error('DSH 原生目录刷新接口不可用');
  await sessions.refresh();
  const snapshot=sessions.list.getSnapshot();
  if(!Array.isArray(snapshot?.ids) || (snapshot.phase !== undefined && snapshot.phase !== 'ready')) throw new Error('DSH 原生目录尚未就绪');
  if(expectedIds.some(id=>!snapshot.ids.includes(id))) throw new Error('原生目录尚未包含已导入会话');
}
function createController(request, timers = globalThis, hooks = {}) {
  let state = {capabilities:null,codexHome:'',activeCodexHome:'',sourceRootChosen:false,sourceDirty:false,sourceBlocked:false,sourceDiscovery:null,scanCompleted:false,sessions:[], workspaces:[], targets:[], selected:[], source:'', query:'', target:'', options:{keepTurns:30, historyMode:'truncate', toolOutputChars:8000, presentation:'readable'}, previews:[], batchId:null, limits:{maxPreviews:Number.MAX_SAFE_INTEGER,maxPreviewBytes:Number.MAX_SAFE_INTEGER}, busy:false, phase:'', error:'', job:null, open:false,directoryBusy:false,directoryStatus:'',directoryError:'',detail:null,detailRef:null,detailBusy:false,detailError:''};
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
  const optionsValid = () => Number.isInteger(state.options.keepTurns) && state.options.keepTurns >= 1 && state.options.keepTurns <= 500 && Number.isInteger(state.options.toolOutputChars) && state.options.toolOutputChars >= 256 && state.options.toolOutputChars <= 64000 && state.options.historyMode === 'truncate' && ['readable','audit'].includes(state.options.presentation);
  const readableReady = () => Array.isArray(state.capabilities?.presentations) && state.capabilities.presentations.includes('readable') && state.capabilities.adaptationVersion === 'readable-v2' && state.capabilities.details === true;
  const backendReady = () => state.options.presentation === 'audit' || readableReady();
  const sourceRootRequired = () => !!state.activeCodexHome || state.sourceRootChosen || state.sourceBlocked;
  const sourceReady = () => !state.sourceBlocked && !state.sourceDirty && state.sourceDiscovery?.found !== false;
  const capacityValid = () => !Number.isFinite(state.limits.maxPreviews) || state.limits.maxPreviews >= Number.MAX_SAFE_INTEGER || state.selected.length <= state.limits.maxPreviews;
  const canConfirmSummary = () => false;
  const canStart = () => !state.busy && optionsValid() && sourceReady() && backendReady() && capacityValid() && !!state.target && state.targets.some(t => t.id === state.target) && state.selected.length > 0 && state.previews.length === state.selected.length && state.previews.every(p => p.previewId && !p.needsSummaryConfirmation && !p.summary && p.options?.historyMode !== 'summary' && p.historyMode !== 'summary' && state.selected.includes(p.sessionId));
  async function scan(applySource = false) {
    if (state.busy) return;
    const codexHome=applySource ? state.codexHome.trim() : state.activeCodexHome;
    if ((applySource || sourceRootRequired()) && state.capabilities?.sourceRoot !== true) { invalidate({error:SOURCE_NOT_READY}); return; }
    const sourceRootChosen=applySource || state.sourceRootChosen;
    const previousPath=state.sourceDiscovery?.path;
    const pendingDraft=state.sourceDirty && !applySource;
    const changing=applySource;
    invalidate({busy:true,sourceDiscovery:null,...(changing ? {sessions:[],workspaces:[],selected:[],source:'',query:'',job:null} : {}),phase:'正在扫描本机 Codex 会话（不会发送模型请求）'});
    const rev = revision;
    try {
      const data = await request('sessions',{includeArchived:false,includeSubagents:false,...(sourceRootChosen ? {codexHome} : {})});
      if (!alive || rev !== revision) return;
      const discovery=data.sourceDiscovery;
      const discoveryValid=discovery && typeof discovery.found === 'boolean' && typeof discovery.path === 'string' && discovery.path.trim().length>0 && ['manual','environment','default'].includes(discovery.source);
      const sourceConfirmed=data.capabilities?.sourceRoot === true && discoveryValid && (!sourceRootChosen || (codexHome ? discovery.found === true && discovery.source === 'manual' : discovery.source !== 'manual'));
      if (sourceRootChosen && !sourceConfirmed) {
        invalidate({busy:false,phase:'',capabilities:data.capabilities || null,sourceBlocked:true,sourceDirty:true,sourceDiscovery:null,scanCompleted:true,sessions:[],workspaces:[],selected:[],source:'',query:'',job:null,error:'后台来源确认无效或能力已降级，请重启DSH后重试；未确认切换来源，未提交导入。'});
        return;
      }
      const sessions = (data.sessions || []).map(({imported,...session})=>session), targets = data.targets || [];
      const rootChanged=changing || (previousPath !== undefined && data.sourceDiscovery?.path !== undefined && previousPath !== data.sourceDiscovery.path);
      const limits={maxPreviews:Number.isSafeInteger(data.limits?.maxPreviews) && data.limits.maxPreviews>0 ? data.limits.maxPreviews : Number.MAX_SAFE_INTEGER,maxPreviewBytes:Number.isSafeInteger(data.limits?.maxPreviewBytes) && data.limits.maxPreviewBytes>0 ? data.limits.maxPreviewBytes : Number.MAX_SAFE_INTEGER};
      const discoveredDraft=sourceConfirmed && discovery.found && !pendingDraft ? discovery.path : null;
      emit({codexHome:discoveredDraft ?? state.codexHome,activeCodexHome:codexHome,sourceRootChosen,sourceBlocked:state.sourceBlocked && !sourceRootChosen,sourceDirty:(state.sourceBlocked && !sourceRootChosen) || pendingDraft || (discoveredDraft===null && state.codexHome.trim()!==codexHome),sourceDiscovery:data.capabilities?.sourceRoot === true ? data.sourceDiscovery || null : null,scanCompleted:true,capabilities:data.capabilities || null,sessions,workspaces:data.workspaces || [],targets,limits,...(rootChanged ? {source:'',query:'',job:null} : {}),selected:rootChanged ? [] : state.selected.filter(id => sessions.some(s => s.id === id)),target:targets.some(t => t.id === state.target) ? state.target : '',error:''});
    } catch(e) { if (alive && rev === revision) emit({sessions:[],workspaces:[],selected:[],sourceDiscovery:null,scanCompleted:true,error:e.code === 'INVALID_CODEX_HOME' ? 'CODEX_HOME 目录无效或不可读取：'+e.message+'。请检查目录后重新扫描；未提交导入。' : e.message}); }
    finally { if (alive && rev === revision) emit({busy:false,phase:''}); }
  }
  async function preview() {
    if (state.busy || !sourceReady() || !state.selected.length || !optionsValid()) return;
    if (!backendReady()) { invalidate({error:BACKEND_NOT_READY}); return; }
    if (!capacityValid()) { emit({error:'本批最多 '+state.limits.maxPreviews+' 个会话，请分批选择；未请求预览或模型。'}); return; }
    invalidate({busy:true,phase:'正在准备本地预览（不调用模型）…',job:null});
    const rev = revision, previews = [], rows = selectedRows();
    abort = new AbortController();
    try {
      const batch=await request('resetPreviews',{},abort.signal);
      if (!alive || rev !== revision) return;
      if (abort.signal.aborted) throw Object.assign(new Error('预览已停止'),{name:'AbortError'});
      if (typeof batch.batchId !== 'string' || !batch.batchId) throw new Error('预览批次无效，请重新进行本地预览。');
      const limits={maxPreviews:Number.isSafeInteger(batch.limits?.maxPreviews) && batch.limits.maxPreviews>0 ? batch.limits.maxPreviews : state.limits.maxPreviews,maxPreviewBytes:Number.isSafeInteger(batch.limits?.maxPreviewBytes) && batch.limits.maxPreviewBytes>0 ? batch.limits.maxPreviewBytes : state.limits.maxPreviewBytes};
      emit({batchId:batch.batchId,limits});
      if(!capacityValid()) throw new Error('本批最多 '+limits.maxPreviews+' 个会话，请分批；未请求预览或模型。');
      for (let i = 0; i < rows.length; i++) {
        emit({phase:'正在预览 ' + (i+1) + '/' + rows.length + ' · ' + rows[i].title + '（仅本地读取，不调用模型）'});
        const data = await request('preview',{sessionId:rows[i].id,options:{...state.options,historyMode:'truncate'},batchId:state.batchId},abort.signal);
        if (!alive || rev !== revision) return;
        if (abort.signal.aborted) throw Object.assign(new Error('预览已停止'),{name:'AbortError'});
        if (data.needsSummaryConfirmation || data.summary || data.options?.historyMode === 'summary' || data.historyMode === 'summary') {
          invalidate({busy:false,error:'插件已停用 AI摘要；后台返回了旧摘要响应，请重启 DSH 后重新预览。',phase:''}); return;
        }
        previews.push({...data,sessionId:rows[i].id});
        emit({previews:[...previews]});
      }
      emit({phase:'预览已就绪。请逐会话检查后确认导入。'});
    } catch(e) { if (alive && rev === revision) {
      if(e.code === 'CAPACITY_LIMIT') emit({error:'预览容量不足，请减少本批会话数、保留轮数或工具输出上限后重新预览；不会自动分批导入。',phase:''});
      else emit({error:e.name === 'AbortError' ? '已停止等待本地预览。' : e.message,phase:''});
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
      catch(e){if(alive && (state.job?.id ?? null)===jobId)emit({directoryStatus:'',directoryError:'导入数据未撤销；目录刷新失败：'+e.message+'。请重新打开导入页面自动刷新，不要重新导入。'});}
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
      const done = TERMINAL.has(job.status);
      emit({job,busy:!done,phase:done ? '批次已结束；已写入的会话会保留，不会自动续跑模型。' : '正在处理导入批次…',error:''});
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
      emit({job,previews:[]}); await poll();
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
    scan:()=>scan(), rescanSource:()=>scan(true), refreshDirectory:()=>refreshDirectory(), preview, confirmSummary:()=>{emit({error:'AI摘要已停用；未请求模型。'});return false;}, start, cancel, refreshProgress:poll,
    set(key,value){ if (state.busy) return; if (key === 'codexHome') { if(String(value)!==state.codexHome) invalidate({codexHome:String(value),sourceDirty:true}); } else if (key === 'options') { if(value.historyMode !== undefined && value.historyMode !== 'truncate') { emit({error:'AI摘要已停用；仅支持 truncate。'}); return; } invalidate({options:{...state.options,...value}}); } else if (['source','query','target'].includes(key)) invalidate({[key]:value}); },
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
    const processingNotes=new Set(["Images are represented by explicit placeholders; original image data is not imported","Encrypted content was not decrypted","Unknown structured content retained as labeled historical JSON","Mixed user metadata boundary ambiguous; original text retained as historical context, not current authorization","Tool calls with missing results retained as labeled history","Pre-user historical response/tool records retained with first source user as historical prefix; original ancestor user is unavailable","Encrypted source content not decrypted; readable fields only are imported","Inherited session metadata does not replace the source file header identity","Fork/segment metadata: inherited records in this file are retained; ancestry is not fetched separately (not full history verification)","Compacted replacement history ignored to avoid duplicated/reinterpreted user turns","Historical system/developer/environment instructions filtered; not activated","Encrypted reasoning not decrypted; only readable summaries imported","Duplicate tool call IDs retained without guessing result ownership","Tool calls without IDs retained as labeled history","Unknown, extra, or ID-less tool results retained as labeled history, not dropped","Historical tool outputs truncated with head/tail and omitted-character count","Unsupported response items retained as explicitly labeled non-executable history","Appended source data excluded from the fixed snapshot","Mixed user metadata did not align; only balanced recognized context prefixes removed, user tail preserved","Mixed user metadata did not align; original readable user text preserved","Mixed historical metadata boundary ambiguous; all user content retained","Unknown historical content provenance retained; runtime-looking text is not evidence of runtime origin","Encrypted collaboration content not decrypted; readable content only is imported"]);
    const contextEstimateNote=/^保留历史约 [0-9]+ 字符，可能超过模型上下文；请减少轮数或工具输出。DSH续聊可能压缩或超限，本插件不保证可直接续聊。$/;
    const displayedWarnings=warnings=>[...new Set((warnings || []).map(String))].filter(w=>!processingNotes.has(w)&&!contextEstimateNote.test(w));
    const previewCard=p=>h('details',{className:'cri-preview-card',key:p.sessionId,open:true},h('summary',null,p.source?.title || p.sessionId),h('div',{className:'cri-preview-stats'},...([['totalTurns','总轮数'],['keptTurns','保留轮数'],['olderTurns','早期轮数'],['toolItems','工具记录'],['filteredMessages','已过滤元信息']].filter(([key])=>p.stats?.[key]!=null).map(([key,label])=>h('span',{className:'cri-preview-stat',key},h('strong',null,String(p.stats[key])),h('span',null,label))))),...displayedWarnings(p.warnings).map((w,i)=>h('p',{className:'cri-notice',key:i},String(w))));
    return h(React.Fragment,null,h('style',null,CSS),h('section',{className:'cri-dialog cri-page','aria-labelledby':'cri-title'},
      h('header',{className:'cri-head'},h('div',null,h('div',{className:'cri-title-line'},h('h2',{id:'cri-title'},'导入 Codex 最近会话'),h('span',{className:'cri-version'},'v'+CLIENT_VERSION)),h('p',{className:'cri-muted'},'只复制历史，不执行工具、不自动续跑；原始 Codex 数据保持不变。本地适配不生成推理。')),button('返回会话',()=>{controller.leave();layout?.selectPanel(null);})),
      h('div',{className:'cri-main','aria-busy':s.busy},
        s.phase ? h('div',{role:'status','aria-live':'polite',className:'cri-notice cri-global-status'},s.phase) : null,
        s.error ? h('div',{role:'alert',className:'cri-error cri-global-status'},s.error) : null,
        s.directoryError ? h('p',{role:'alert',className:'cri-error cri-global-status'},s.directoryError) : null,
        s.job ? h('section',{className:'cri-stack cri-batch-progress','aria-label':'导入进度'},h('h3',{className:'cri-section'},'批次进度 · '+finished+'/'+items.length),h('progress',{className:'cri-progress',value:finished,max:Math.max(1,items.length),'aria-label':'已结束会话数'}),...items.map((item,i)=>h('div',{className:'cri-row',key:i},h('span',null,(s.sessions.find(r=>r.id===item.sessionId)?.title || item.sessionId || '会话')+' · '+(LABELS[item.status] || item.status),item.error ? h('small',{className:'cri-error cri-global-status'},typeof item.error === 'string' ? item.error : item.error.message) : null,item.warning ? h('small',null,String(item.warning)) : null))),button('刷新任务进度',()=>controller.refreshProgress()),!s.busy && items.some(i=>i.status==='failed') ? button('重新选择失败项',()=>controller.retry()) : null) : null,
        h('div',{className:'cri-workbench'},
          h('section',{className:'cri-pane cri-source-pane','aria-label':'来源会话'},h('header',{className:'cri-pane-head'},h('h3',{className:'cri-section'},'来源会话')),h('div',{className:'cri-pane-body cri-stack'},
            h('details',{className:'cri-config-details',open:!s.scanCompleted || s.sourceDirty || s.sourceBlocked || s.sourceDiscovery?.found !== true},h('summary',null,'来源目录 / 发现方式：'+({manual:'手动指定',environment:'环境变量 CODEX_HOME',default:'默认目录'}[s.sourceDiscovery?.source] || '待确认')),
            h('p',{className:s.sourceDiscovery?.found?'cri-muted':'cri-notice',role:'status'},s.sourceDiscovery ? (s.sourceDiscovery.found ? '发现方式：'+({manual:'手动指定',environment:'环境变量 CODEX_HOME',default:'默认目录'}[s.sourceDiscovery.source] || '未知') : '未找到可读取的 Codex 来源目录：'+(s.sourceDiscovery.message || '请填写 CODEX_HOME 后重新扫描。')) : (s.scanCompleted && s.capabilities?.sourceRoot !== true ? '后台未支持来源选择；当前仅兼容旧版自动扫描。手填目录需重启DSH后重试。' : '等待扫描确认实际 CODEX_HOME 目录。')),
            field('CODEX_HOME（可选更换；留空自动发现）',h('input',{type:'text',className:'cri-input',value:s.codexHome,disabled:s.busy,placeholder:'填写运行 DSH 的主机可读取的 Codex 目录',onChange:e=>controller.set('codexHome',e.target.value)})),
            h('details',{className:'cri-platform-details'},h('summary',null,'Windows / WSL 目录填写说明'),h('p',{className:'cri-muted'},'目录仅在点击下方按钮后应用。Windows 可手填 WSL UNC 路径，例如 ',h('code',null,String.raw`\\wsl.localhost\Ubuntu\home\用户名\.codex`),'；插件不执行 WSL 启动命令，请先确保发行版及路径可访问。若 DSH 在 WSL 内运行，请填 Linux 路径，例如 /home/用户名/.codex。此示例未作 Windows 实机验证。'))),
            button(s.sourceDirty?'应用目录并扫描':'刷新会话列表',()=>s.sourceDirty?controller.rescanSource():controller.scan(),s.busy),
            s.sourceDirty ? h('p',{className:'cri-notice'},'目录草稿待应用，旧预览已失效；请点击“应用目录并扫描”后再预览或导入。') : null,
            select('来源 workspace / worktree',s.source,[['','全部来源目录'],...s.workspaces.map(w=>[w.path,w.path+' · '+w.count+' 个会话'])],value=>controller.set('source',value)),
            field('搜索会话标题',h('input',{type:'search',className:'cri-input',value:s.query,disabled:s.busy,placeholder:'输入标题关键词',onChange:e=>controller.set('query',e.target.value)})),
            h('details',{className:'cri-config-details',open:!controller.capacityValid()},h('summary',null,'导入范围与容量'),
            h('p',{className:'cri-muted'},'仅导入所选主会话，不导入子代理的独立对话。主日志中已有的子代理调用和返回结果仍作为历史保留；不会恢复原来的多代理运行状态。')),
            h('div',{className:'cri-inline cri-toolbar'},button('选择筛选结果',()=>controller.selectVisible(),s.busy || !rows.length),button('清空选择',()=>controller.clear(),s.busy || !s.selected.length)),
            h('p',{className:'cri-muted cri-selected-count'},'已选 '+s.selected.length+' 个 · 当前筛选 '+rows.length+' 个（隐藏项仍保留选择）'),
            h('div',{className:'cri-list cri-source-list'},rows.length ? rows.map(row=>h('label',{className:'cri-row cri-source-row',key:row.id},h('input',{type:'checkbox',checked:s.selected.includes(row.id),disabled:s.busy,onChange:()=>controller.select(row.id)}),h('span',{className:'cri-row-main'},row.title || '未命名会话',h('small',null,row.cwd || '未知目录'),h('small',null,formatActivity(row.updatedAt)+' · '+formatBytes(row.bytes)+' · 轮数预览后统计'),h('small',null,[row.archived?'已归档':'',row.subagent?'子代理':''].filter(Boolean).join(' · '))))) : h('p',{className:'cri-muted'},s.busy ? '正在读取列表…' : '没有匹配的主会话。可调整搜索条件或刷新会话列表。')))),
        h('section',{className:'cri-pane cri-preview-pane','aria-label':'逐会话预览'},h('header',{className:'cri-pane-head'},h('h3',{className:'cri-section'},'逐会话预览')),h('div',{className:'cri-pane-body cri-previews'},!s.previews.length ? h('div',{className:'cri-empty-state'},h('h4',null,'尚未生成预览'),h('p',{className:'cri-muted'},'选择来源会话并点击“预览所选”，在此检查保留轮次、工具截断和警告；本地预览不会写入 DSH 会话。')) : s.previews.map(previewCard),
        s.detailRef ? h('section',{className:'cri-previews cri-detail-panel','aria-label':'来源详情','aria-busy':s.detailBusy},h('h4',null,'原始历史详情（只读）'),
            s.detailBusy ? h('p',{role:'status'},'正在本机读取详情…') : null,
            s.detailError ? h('p',{className:'cri-error',role:'alert'},s.detailError) : null,
            s.detail ? h(React.Fragment,null,h('h4',null,s.detail.source?.title || '历史来源'),h('pre',null,JSON.stringify({source:s.detail.source,presentation:s.detail.presentation,version:s.detail.version,stats:s.detail.stats},null,2)),
              ...displayedWarnings(s.detail.warnings).map((w,i)=>h('p',{key:i,className:'cri-notice'},String(w))),
              ...s.detail.records.map(r=>h('div',{key:r.index},h('p',null,'记录 '+r.index+(r.truncated?' · 已截断（非完整记录）':'')),h('pre',null,String(r.text ?? '')))),
              h('p',null,'偏移 '+s.detail.offset+' · 总记录 '+s.detail.total),
              button('上一页',()=>controller.previousDetails(),s.detailBusy || s.detail.offset<=0),button('下一页',()=>controller.nextDetails(),s.detailBusy || s.detail.nextOffset==null)) : null,
            button(s.detailBusy?'取消读取详情':'关闭详情',()=>controller.closeDetails())) : null,
        )),
          h('section',{className:'cri-pane cri-settings-pane','aria-label':'导入设置'},h('header',{className:'cri-pane-head'},h('h3',{className:'cri-section'},'导入设置')),h('div',{className:'cri-pane-body cri-stack'},
            select('目标 DSH workspace',s.target,[['','请选择目标工作区'],...s.targets.map(t=>[t.id,t.title || t.id])],v=>controller.set('target',v),{'aria-invalid':targetMissing,'aria-describedby':targetMissing?'cri-target-required':undefined}),
            targetMissing && s.targets.length ? h('p',{id:'cri-target-required',className:'cri-error'},targetHint) : null,
            !s.targets.length ? h('p',{id:'cri-target-required',className:'cri-muted'},'暂无目标工作区，请先在 DSH 中创建或打开工作区后刷新。') : null,
            !controller.backendReady() ? h('p',{role:'alert',className:'cri-error'},BACKEND_NOT_READY) : null,
            select('历史展示方式',s.options.presentation,[['readable','阅读／续聊适配（推荐）'],['audit','完整审计']],v=>controller.set('options',{presentation:v})),
            field('保留最近用户轮数 N（1–500）',h('input',{type:'number',className:'cri-input',min:1,max:500,step:1,value:s.options.keepTurns,disabled:s.busy,onChange:e=>controller.set('options',{keepTurns:e.target.value === '' ? '' : Number(e.target.value)})})),
            h('p',{className:'cri-notice'},'仅导入最近N轮，更早历史不导入；导入过程中不请求模型'),
            h('details',{className:'cri-config-details'},h('summary',null,'高级：工具输出预算'),field('每条工具输出字符上限（256–64000，保留头尾）',h('input',{type:'number',className:'cri-input',min:256,max:64000,step:1,value:s.options.toolOutputChars,disabled:s.busy,onChange:e=>controller.set('options',{toolOutputChars:e.target.value === '' ? '' : Number(e.target.value)})}))),
            !controller.optionsValid() ? h('p',{role:'alert',className:'cri-error'},'请输入范围内的整数。') : null,
            h('p',{className:'cri-muted'},'修改筛选、选择、目标或参数后，原预览立即失效。导入前必须重新预览。'))))),
      h('footer',{className:'cri-foot'},h('span',{className:!s.busy && targetMissing?'cri-error':'cri-muted',role:'status'},s.busy ? '正在处理，请勿重复开始；已写入会话不会因取消而删除。' : targetMissing ? (s.targets.length?targetHint:'暂无目标工作区，请先在 DSH 中创建或打开工作区后刷新。') : '确认开始后才写入目标工作区；重复导入将由服务端明确跳过。'),h('div',{className:'cri-inline'},s.busy ? button(s.job?'取消剩余任务':'停止等待预览',()=>controller.cancel(),!s.job && !s.phase.includes('预览')) : null,button('预览所选',()=>controller.preview(),s.busy || !s.selected.length || !controller.optionsValid() || !controller.capacityValid()),button('确认并开始导入',()=>controller.start(),!controller.canStart(),true)))));
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
