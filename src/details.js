const RECORD_CHARS=16000;
export function detailPage(prepared,{offset=0,limit=10}={}) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20)throw Object.assign(new Error('详情分页参数无效'),{code:'INVALID_DETAILS'});
  const adaptation=prepared.adaptation;
  const records=adaptation?.presentation==='readable'?(adaptation.details ?? []):prepared.turns.flatMap((turn,i)=>turn.items.filter(item=>item.kind==='tool').map(item=>({turn:i+1,...item})));
  const page=records.slice(offset,offset+limit).map((record,i)=>{const raw=JSON.stringify(record);let text=raw.slice(0,RECORD_CHARS);if(/[\uD800-\uDBFF]/.test(text.at(-1)??''))text=text.slice(0,-1);return {index:offset+i,text,truncated:raw.length>text.length};});
  const {path,...source}=prepared.source;
  return {detail:{source,presentation:adaptation?.presentation ?? 'audit',version:adaptation?.version ?? 'audit-v1',stats:adaptation?.stats ?? {},records:page,offset,total:records.length,nextOffset:offset+page.length<records.length?offset+page.length:null,warnings:prepared.warnings ?? []}};
}
