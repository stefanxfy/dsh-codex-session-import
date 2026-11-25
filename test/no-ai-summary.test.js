import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createService,normalizeOptions} from '../src/host.js';
import {createModelAdapter,inject} from '../index.js';

test('new options default truncate and explicit summary can never opt back in',()=>{
 assert.equal(normalizeOptions().historyMode,'truncate');
 for(const options of [{historyMode:'summary'},{historyMode:'summary',allowAiSummary:true},{historyMode:'summary',keepTurns:0}])assert.throws(()=>normalizeOptions(options),{code:'AI_SUMMARY_DISABLED'});
 assert.throws(()=>normalizeOptions({historyMode:'other'}),{code:'INVALID_OPTIONS'});
});

test('summary rejection precedes source lookup, prepare, estimates and hostile model dependencies',async()=>{
 let prepares=0,accesses=0;
 const deps={prepareSession:async()=>{prepares++;throw Error('forbidden prepare');}};
 for(const key of ['modelKey','generate'])Object.defineProperty(deps,key,{get(){accesses++;throw Error('forbidden model access');}});
 const service=createService(deps);
 try{
  for(const request of [{options:{historyMode:'summary'}},{confirmSummary:true},{confirmSummary:true,options:{historyMode:'truncate'}},{confirmSummary:true,options:{historyMode:'summary'}}])await assert.rejects(service.preview(request),{code:'AI_SUMMARY_DISABLED'});
  assert.equal(prepares,0);assert.equal(accesses,0);
 }finally{await service.dispose();}
});

test('host and entrypoint contain no cache or model execution path',async()=>{
 const host=await readFile(new URL('../src/host.js',import.meta.url),'utf8');
 const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
 assert.doesNotMatch(host,/summary-cache\.json|summarizeChunks|deps\.(?:generate|modelKey)/);
 assert.doesNotMatch(entry,/llm\.stream|ctx\.agentDefaultModel|ctx\.llm/);
 assert.equal(inject.includes('llm'),false);assert.equal(inject.includes('agentDefaultModel'),false);
 assert.throws(()=>createModelAdapter(),{code:'AI_SUMMARY_DISABLED'});
});
