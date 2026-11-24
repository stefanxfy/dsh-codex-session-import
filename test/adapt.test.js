import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareSession} from '../src/core.js';
import {buildEvents} from '../src/events.js';
import {isSchemaOutput} from '../src/adapt.js';
const record = payload => ({type:'response_item',timestamp:'2026-01-01T00:00:00Z',payload});
const message = (role,text,extra={}) => record({type:'message',role,content:[{type:'input_text',text}],...extra});
const user = text => message('user',text);
const tool = (name,output,id='call') => [record({type:'function_call',name,call_id:id,arguments:'{"path":"file"}'}),record({type:'function_call_output',call_id:id,output})];
async function fixture(t,records) {
  const home=await mkdtemp(join(tmpdir(),'readable-adapt-')); t.after(()=>rm(home,{recursive:true,force:true}));
  const dir=join(home,'.codex','sessions'); await mkdir(dir,{recursive:true}); const path=join(dir,'history.jsonl');
  const raw=[{type:'session_meta',payload:{id:'fixture',title:'Original'}},...records].map(JSON.stringify).join('\n')+'\n';
  await writeFile(path,raw); return {home,path,raw};
}
const schema=JSON.stringify({tools:[{type:'function',function:{name:'old_tool',parameters:{type:'object',properties:{SECRET_SCHEMA:{type:'string'}}}}}]});

test('default audit preserves native tools and explicit audit agrees',async t=>{
  const f=await fixture(t,[user('question'),...tool('read','answer')]);
  const p=await prepareSession(f), explicit=await prepareSession({...f,presentation:'audit'});
  assert.deepEqual(p,explicit); assert.equal(p.adaptation.presentation,'audit'); assert.equal(p.adaptation.version,'readable-v2');
  assert.equal(buildEvents(p).events.filter(e=>e.type==='tool/call').length,1);
  await assert.rejects(prepareSession({...f,presentation:'other'}),/presentation/);
});

test('readable merges every tool including unknown and ID-less with bounded traceable details',async t=>{
  const f=await fixture(t,[user('question'),...tool('read','key result'),...tool('catalog',schema,'catalog-id'),record({type:'function_call_output',name:'mystery',output:'orphan evidence'}),record({type:'custom_tool_call',name:'no-result',input:'raw input'}),message('assistant','normal answer')]);
  const p=await prepareSession({...f,presentation:'readable'}), summaries=p.turns[0].items.filter(i=>i.kind==='tool-summary');
  assert.equal(summaries.length,1); assert.equal(p.adaptation.details.length,4); assert.match(summaries[0].text,/read.*key result/); assert.match(summaries[0].text,/mystery.*orphan evidence/);
  assert.doesNotMatch(summaries[0].text,/SECRET_SCHEMA|catalog-id/);
  const d=p.adaptation.details.find(d=>d.name==='catalog'); assert.equal(d.callId,'catalog-id'); assert.equal(d.arguments,'{"path":"file"}'); assert.equal(d.output,schema); assert.equal(d.turn,1); assert.equal(d.sourceLine,5); assert.equal(d.outputSourceLine,6);
  assert.ok(p.turns.every(t=>Number.isInteger(t.sourceLine)&&t.items.every(i=>Number.isInteger(i.sourceLine))));
  const {events,title}=buildEvents(p); const body=JSON.stringify(events);
  assert.equal(events.filter(e=>e.type==='tool/call'||e.type==='tool/result').length,0); assert.equal((body.match(/历史安全说明/g)||[]).length,1); assert.equal((body.match(/历史工具摘要/g)||[]).length,1);
  assert.doesNotMatch(body,/SECRET_SCHEMA|Source call ID|NOT new authorization|catalog-id/); assert.match(body,/normal answer/); assert.equal(title,p.source.title);
});

test('only explicit metadata boundaries removed; code JSON and schema discussions survive',async t=>{
  const prose='Discuss JSON function namespace schema. \n'+'```js\nfunction schema() { return {namespace:"kept"}; }\n```';
  const f=await fixture(t,[message('user','unused',{content:[{type:'input_text',text:'OLD_ENV'},{type:'input_text',text:prose}],metadata:{content_item_kinds:['harness.environment','user.text']}}),record({type:'tool_definitions',text:'OLD_DEFS'}),message('assistant',schema),record({type:'tool_definitions',tools:[{name:'OLD_REG'}]}),user('<environment_context>unclosed user request'),record({type:'future_kind',data:{namespace:'unknown preserved'}}),message('user','look',{content:[{type:'input_image',image_url:'https://invalid.test/img'}]})]);
  const p=await prepareSession({...f,presentation:'readable'}), body=JSON.stringify(p.turns);
  assert.doesNotMatch(body,/OLD_ENV|OLD_DEFS|OLD_REG/); assert.ok(body.includes('Discuss JSON function namespace schema')); assert.ok(body.includes('SECRET_SCHEMA')); assert.match(body,/unclosed user request|unknown preserved|Historical image omitted/);
  assert.match(p.warnings.join(' '),/provenance retained/); assert.match(p.warnings.join(' '),/Unsupported/); assert.ok(p.adaptation.stats.filteredMetadata>=3);
});

test('adaptation precedes older chunk archive and details use retained ring only',async t=>{
  const f=await fixture(t,[user('old'),...tool('catalog',schema),user('new'),...tool('read','latest')]);
  const p=await prepareSession({...f,presentation:'readable',keepTurns:1});
  assert.doesNotMatch(p.olderChunks.join(''),/SECRET_SCHEMA|callId|parameters/); assert.match(p.olderChunks.join(''),/历史工具摘要|catalog/);
  assert.equal(p.adaptation.details.length,1); assert.equal(p.adaptation.details[0].turn,2); assert.equal(p.stats.olderTurns,1); assert.equal(p.adaptation.stats.mergedToolRecords,2);
  assert.equal(p.source.sha256,createHash('sha256').update(f.raw).digest('hex')); assert.ok(p.olderChunks.every(c=>c.length<=24000));
  const truncated=await prepareSession({...f,presentation:'readable',keepTurns:1,historyMode:'truncate'}); assert.deepEqual(truncated.olderChunks,[]);
});

test('large schema remains only budgeted detail even after JSON clipping',async t=>{
  const huge=JSON.stringify({type:'object',properties:{SECRET_SCHEMA:{description:'x'.repeat(10000)}}});
  const f=await fixture(t,[user('large'),...tool('catalog',huge,'trace-id')]); const p=await prepareSession({...f,presentation:'readable',toolOutputChars:256});
  assert.doesNotMatch(JSON.stringify(p.turns),/SECRET_SCHEMA|description/); const d=p.adaptation.details[0];
  assert.ok(d.output.length+d.arguments.length+d.callId.length<=256); assert.equal(d.callId,'trace-id'); assert.equal(d.truncated,true); assert.match(d.output,/SECRET_SCHEMA/);
  assert.equal(isSchemaOutput('{"schema":"ordinary JSON","function":"discussion"}'),false);
  const ordinary=await fixture(t,[user('json'),...tool('read','{"schema":"ordinary JSON","function":"discussion"}')]);
  assert.match(JSON.stringify((await prepareSession({...ordinary,presentation:'readable'})).turns),/ordinary JSON/);
});

test('additional_tools runtime records are removed by structure with bounded provenance, not text keywords',async t=>{
  const f=await fixture(t,[record({type:'additional_tools',tools:[{name:'runtime',parameters:{description:'x'.repeat(5000)}}]}),user('Explain additional_tools in JSON, function namespace schema'),message('assistant','additional_tools is an ordinary technical term')]);
  const p=await prepareSession({...f,presentation:'readable',toolOutputChars:256});
  assert.doesNotMatch(JSON.stringify(p.turns),/parameters|description/); assert.match(p.turns[0].user,/Explain additional_tools/); assert.match(p.turns[0].items[0].text,/ordinary technical term/);
  const d=p.adaptation.details[0]; assert.equal(d.name,'additional_tools'); assert.equal(d.sourceLine,2); assert.equal(d.turn,1); assert.equal(d.kind,'metadata'); assert.ok(d.output.length<=256); assert.equal(d.truncated,true); assert.equal(p.adaptation.stats.filteredMetadata,1);
  assert.match(JSON.stringify((await prepareSession(f)).turns),/parameters|description/);
});

test('readable preserves aligned mixed user metadata and keeps long tool context concise',async t=>{
  const f=await fixture(t,[message('user','unused',{content:[{type:'environment_context',text:'OLD_CONTEXT'},{type:'input_text',text:'real user tail'}],metadata:{content_item_kinds:['harness.environment','user.text']}}),...tool('read','HEAD'+ 'x'.repeat(5000)+'TAIL')]);
  const p=await prepareSession({...f,presentation:'readable'});
  assert.equal(p.turns[0].user,'real user tail'); assert.doesNotMatch(JSON.stringify(p.turns),/OLD_CONTEXT/);
  const summary=p.turns[0].items[0].text; assert.ok(summary.length<700); assert.match(summary,/HEAD/); assert.match(summary,/TAIL/); assert.match(summary,/省略/); assert.ok(p.adaptation.details[0].output.length>5000);
});

test('assistant labels and explicit user.text win over runtime-looking text and structure',async t=>{
  const assistantExample='<INSTRUCTIONS>example only</INSTRUCTIONS>\nExplain this literal tag.';
  const explicitUser='<tool_definitions>my schema example</tool_definitions>\nDo not remove my text.';
  const unmarked='<environment_context>quoted example</environment_context>\nreal tail';
  const f=await fixture(t,[message('user',explicitUser,{metadata:{content_item_kinds:['user.text']}}),message('assistant',assistantExample),message('user','unused',{content:[{type:'environment_context',text:'typed user-owned example'}],metadata:{content_item_kinds:['user.text']}}),message('assistant','<tool_definitions>assistant example</tool_definitions>'),user(unmarked),message('user','<INSTRUCTIONS>mismatched example</INSTRUCTIONS>',{metadata:{content_item_kinds:['harness.environment','user.text']}})]);
  const p=await prepareSession({...f,presentation:'readable'});
  assert.equal(p.turns[0].user,explicitUser); assert.equal(p.turns[0].items[0].text,assistantExample); assert.equal(p.turns[1].user,'typed user-owned example'); assert.equal(p.turns[1].items[0].text,'<tool_definitions>assistant example</tool_definitions>'); assert.equal(p.turns[2].user,unmarked); assert.equal(p.turns[3].user,'<INSTRUCTIONS>mismatched example</INSTRUCTIONS>');
  assert.equal(p.adaptation.stats.filteredMetadata,0); assert.match(p.warnings.join(' '),/provenance retained/); assert.match(p.warnings.join(' '),/ambiguous/);
  const text=JSON.stringify(buildEvents(p).events); assert.ok(text.includes('example only')); assert.ok(text.includes('my schema example'));
});

test('observed Codex runtime provenance categories do not create user turns',async t=>{
  const envelope='# AGENTS.md instructions for /synthetic\n\n<INSTRUCTIONS>OLD_RUNTIME</INSTRUCTIONS>\n<environment_context>OLD_ENV</environment_context>';
  const f=await fixture(t,[message('user','unused',{content:[{type:'input_text',text:'# AGENTS.md instructions for /synthetic\n\n<INSTRUCTIONS>OLD_RUNTIME</INSTRUCTIONS>'},{type:'input_text',text:'<environment_context>OLD_ENV</environment_context>'}],metadata:{content_item_kinds:['agents_md.instructions','environments.environment_context']}}),message('user','actual first',{metadata:{content_item_kinds:['user.text']}}),message('user',envelope,{metadata:{content_item_kinds:['agents_md.instructions']}}),message('user','actual second',{metadata:{content_item_kinds:['user.text']}}),message('assistant',envelope),message('user',envelope,{metadata:{content_item_kinds:['user.text']}}),user(envelope+'\nPlease explain this example.')]);
  const p=await prepareSession({...f,presentation:'readable'});
  assert.equal(p.stats.totalTurns,4); assert.equal(p.turns[0].user,'actual first'); assert.equal(p.turns[1].user,'actual second'); assert.equal(p.turns[1].items[0].text,envelope); assert.equal(p.turns[2].user,envelope); assert.equal(p.turns[3].user,envelope+'\nPlease explain this example.');
  assert.equal(p.adaptation.stats.filteredMetadata,3); assert.match(p.warnings.join(' '),/provenance retained/); assert.equal(p.source.sha256,createHash('sha256').update(f.raw).digest('hex'));
});

test('readable cancellation and line byte limits fail closed',async t=>{
  const f=await fixture(t,[user('question')]);
  await assert.rejects(prepareSession({...f,presentation:'readable',signal:AbortSignal.abort()}),{name:'AbortError'});
  await assert.rejects(prepareSession({...f,presentation:'readable',maxLineBytes:20}),/maxLineBytes/);
});
