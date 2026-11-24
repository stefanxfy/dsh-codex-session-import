import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../client.js',import.meta.url),'utf8');
const box={AbortController,setTimeout,clearTimeout};
vm.runInNewContext(source.replace("if (typeof window === 'undefined'","globalThis.createForTest=createController; if (typeof window === 'undefined'"),box);
test('UI archive inclusion is unavailable even if stale caller tries to enable it',async()=>{const calls=[];const c=box.createForTest(async(endpoint,payload)=>{calls.push({endpoint,payload});return {sessions:[],workspaces:[],targets:[]};});c.set('includeArchived',true);c.set('includeSubagents',true);await c.scan();assert.equal(c.get().includeArchived,undefined);assert.equal(c.get().includeSubagents,undefined);assert.equal(calls[0].payload.includeSubagents,false);assert.equal(calls.length,1);assert.equal(calls[0].payload.includeArchived,false);assert.equal(calls.some(x=>x.endpoint==='jobs'),false);c.dispose();});
