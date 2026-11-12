import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {renderFinanceReviewPage} from '../finance-review-page.ts';
import {buildFinanceReview,parseFinanceReviewQuery} from './finance-review.ts';
import type {AccountClassification} from './finance-review.ts';

async function settle(check:()=>boolean){for(let i=0;i<50;i++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.ok(check());}
test('monthly review draws dated classification effects and clearly labels assumed legacy history',async()=>{
 const {window,document}=parseHTML(renderFinanceReviewPage());const location=new URL('https://synthetic.example/finance/review?month=2026-11');
 const a={accountId:'a',name:'合成账户',type:'loan' as const,ledger:'personal' as const,currency:'CNY' as const,archivedAt:null};
 const history:AccountClassification[]=[{accountId:'a',revision:1,effectiveFrom:'1970-01-01',type:'bank',archived:0,origin:'baseline',recordedAt:'2026-11-01T03:00:00Z'},{accountId:'a',revision:2,effectiveFrom:'2026-11-05',type:'loan',archived:0,origin:'change',recordedAt:'2026-11-05T03:00:00Z'}];
 const data=buildFinanceReview([a],[{accountId:'a',amountMinor:'10000',asOfDate:'2026-10-01',sequence:1}],parseFinanceReviewQuery(new URLSearchParams('month=2026-11'),new Date('2026-11-12T03:00:00Z')),history);
 let calls=0;const source=[...document.querySelectorAll('script')].find(node=>node.textContent?.includes("const root=document.getElementById('monthly-review')"))!.textContent!;
 runInNewContext(source,{window,document,location,history:{replaceState(_s:unknown,_t:string,path:string){location.href=new URL(path,location).href;}},URL,URLSearchParams,Intl,Date,AbortController,fetch:async()=>{calls++;return Response.json(data);}});
 await settle(()=>!document.getElementById('review-content')!.hidden);
 assert.match(document.getElementById('review-scope')!.textContent!,/基线记录日前的历史无法核实/);
 assert.match(document.getElementById('review-breakdown')!.textContent!,/已有账户余额变化 CNY 0\.00.*分类调整影响 CNY -200\.00/);
 assert.match(document.getElementById('review-accounts')!.textContent!,/贷款（原 银行存款）/);
 assert.match(document.getElementById('review-accounts')!.textContent!,/分类影响 CNY -200\.00/);
 assert.equal(calls,1);assert.equal(document.querySelectorAll('#review-chart svg').length,1);
});
