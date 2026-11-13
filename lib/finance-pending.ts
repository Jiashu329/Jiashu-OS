/** Kept as a self-contained browser source literal: production minification must not
 * turn serialized function references into names outside their browser scope. */
export const FINANCE_PENDING_SCRIPT = String.raw`
function createFinancePendingStore(ownerId,storage,scopeKey=''){
 const key='jiashu-finance-pending:v1:'+encodeURIComponent(ownerId)+(scopeKey?':scope:'+encodeURIComponent(scopeKey):'');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 const scopeParts=typeof scopeKey==='string'&&scopeKey?scopeKey.split(':'):null;
 const scopeBook=scopeParts?.[0],scopeRevision=scopeParts?.[1];
 const scopeValid=!scopeKey||(scopeParts?.length===2&&uuid.test(scopeBook)&&/^(0|[1-9]\d*)$/.test(scopeRevision)&&Number.isSafeInteger(Number(scopeRevision)));
 const ledgers=['personal','family'],currencies=['CNY','HKD','USD','EUR','GBP','SGD','AUD','CAD','JPY'];
 const types=['cash','bank','investment','property','receivable','other_asset','credit_card','loan','other_liability'];
 let pending=null,problem='';
 const invalid=()=>new Error('上次财务提交的确认信息暂时无法读取，请保留本标签页并先核对账户与余额。');
 const text=(value,max,required=false)=>typeof value==='string'&&value.length<=max&&(!required||Boolean(value.trim()));
 function validDay(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1970-01-01'||value>'2100-12-31')return false;const parsed=Date.parse(value+'T12:00:00Z');return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value;}
 function clean(value){
  const body=value?.body,account=value?.account;
  const originalPath=value?.path;
  if(typeof originalPath!=='string'||originalPath.includes('#'))throw invalid();
  const parts=originalPath.split('?');if(parts.length>2)throw invalid();
  const pathname=parts[0];
  if(!scopeValid||(scopeKey&&parts.length!==2))throw invalid();
  if(parts.length===2){
   const query=parts[1].split('&');if(query.length!==2)throw invalid();
   const book=query.find((pair)=>pair.startsWith('book=')),revision=query.find((pair)=>pair.startsWith('bookRevision='));
   if(!book||!revision||!uuid.test(book.slice(5))||!/^bookRevision=(0|[1-9]\d*)$/.test(revision)||!Number.isSafeInteger(Number(revision.slice(13))))throw invalid();
   if(scopeKey&&(book.slice(5)!==scopeBook||revision.slice(13)!==scopeRevision))throw invalid();
  }
  if(!value||value.version!==1||value.ownerId!==ownerId||!uuid.test(value.key)||!['account','balance','change'].includes(value.kind)||!body||typeof body!=='object'||Array.isArray(body)||!Number.isFinite(Date.parse(value.createdAt)))throw invalid();
  if(value.kind!=='change'&&(!text(body.amount,128,true)||!validDay(body.asOfDate)||!text(body.note,500)))throw invalid();
  let cleanBody,cleanAccount=null,path;
  if(value.kind==='account'){
   if(pathname!=='/api/finance/accounts'||!ledgers.includes(body.ledger)||!currencies.includes(body.currency)||!types.includes(body.type)||!text(body.name,60,true)||Object.keys(body).some((name)=>!['ledger','currency','type','name','note','amount','asOfDate'].includes(name)))throw invalid();
   path=originalPath;cleanBody={name:body.name,type:body.type,note:body.note,ledger:body.ledger,currency:body.currency,amount:body.amount,asOfDate:body.asOfDate};
  }else{
   if(!account||!uuid.test(account.id)||!ledgers.includes(account.ledger)||!currencies.includes(account.currency)||!types.includes(account.type)||!text(account.name,60,true))throw invalid();
   cleanAccount=Object.freeze({id:account.id,name:account.name,type:account.type,ledger:account.ledger,currency:account.currency});
   const prefix='/api/finance/accounts/'+account.id+'/balances';
   if(value.kind==='balance'){
    if(pathname!==prefix||Object.keys(body).some((name)=>!['note','amount','asOfDate'].includes(name)))throw invalid();
    path=originalPath;cleanBody={amount:body.amount,asOfDate:body.asOfDate,note:body.note};
   }else{
    if(!pathname.startsWith(prefix+'/'))throw invalid();
    let entry;try{entry=decodeURIComponent(pathname.slice(prefix.length+1));}catch{throw invalid();}
    if(!uuid.test(entry)&&!(entry.startsWith('initial:')&&uuid.test(entry.slice(8))))throw invalid();
    if(!['correct','void'].includes(body.action)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0||!Number.isSafeInteger(body.expectedAccountRevision)||body.expectedAccountRevision<0||!text(body.reason,300,true))throw invalid();
    const allowed=['action','expectedRevision','expectedAccountRevision','reason',...(body.action==='correct'?['amount','asOfDate','note']:[])];
    if(Object.keys(body).some((name)=>!allowed.includes(name)))throw invalid();
    path=value.path;cleanBody={action:body.action,expectedRevision:body.expectedRevision,expectedAccountRevision:body.expectedAccountRevision,reason:body.reason};
    if(body.action==='correct'){if(!text(body.amount,128,true)||!validDay(body.asOfDate)||!text(body.note,500))throw invalid();Object.assign(cleanBody,{amount:body.amount,asOfDate:body.asOfDate,note:body.note});}
   }
  }
  return Object.freeze({version:1,ownerId,key:value.key.toLowerCase(),kind:value.kind,path,body:Object.freeze(cleanBody),account:cleanAccount,createdAt:value.createdAt});
 }
 function remember(operation){const normalized=clean(operation);if(!ownerId)throw new Error('请刷新并重新登录，再提交财务记录。');try{storage().setItem(key,JSON.stringify(normalized));}catch{throw new Error('浏览器无法保留本次提交标识，本次未发送。请允许当前标签页的会话存储后重试。');}pending=normalized;return pending;}
 function stage(kind,path,body,account=null){if(problem)throw new Error(problem);if(pending)return pending;if(scopeKey&&typeof path==='string'&&!path.includes('?'))path+='?book='+scopeBook+'&bookRevision='+scopeRevision;return remember({version:1,ownerId,key:crypto.randomUUID(),kind,path,body,account,createdAt:new Date().toISOString()});}
 function clear(){try{storage().removeItem(key);}catch{problem='财务结果已返回，但本地确认信息未能清理。请保留本标签页后重试确认原操作。';throw new Error(problem);}pending=null;problem='';}
 if(ownerId){try{const raw=storage().getItem(key);if(raw){if(raw.length>8192)throw invalid();pending=clean(JSON.parse(raw));}}catch{problem=invalid().message;}}
 return {get value(){return pending;},get problem(){return problem;},stage,clear,
  definiteRejection(error){if(['FINANCE_BOOK_ACCESS_REVOKED','FINANCE_BOOK_ACCESS_CHANGED'].includes(error?.code))return false;return [400,403,404,409,413,415,422].includes(error?.status);},
  matchesResult(result){if(!pending||!result?.account)return false;if(pending.kind==='account')return result.account.id===pending.key;const rows=pending.kind==='change'?result.changes:result.balances;return result.account.id===pending.account.id&&Array.isArray(rows)&&rows.some((entry)=>entry.id===pending.key);}
 };
}
`;
