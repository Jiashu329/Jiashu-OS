import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { prepareNutritionPhoto } from './nutrition-photo-file.ts';

function jpeg(width = 4000, height = 3000, metadata = '') {
  const bytes = new Uint8Array([255,216,255,225,0,metadata.length+2,...new TextEncoder().encode(metadata),255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,0,3,17,0,255,217]);
  return new File([bytes], 'food.jpg', { type: 'image/jpeg' });
}
function png(width: number, height: number) {
  const bytes=new Uint8Array(33);bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);return new File([bytes],'food.png',{type:'image/png'});
}
function output(size=4) { const bytes=new Uint8Array(size);bytes.set([255,216]);bytes.set([255,217],size-2);return new Blob([bytes],{type:'image/jpeg'}); }
function fixture(options:{width?:number;height?:number;fallback?:boolean;decodeFailure?:boolean;sizes?:number[];emptyCanvas?:boolean}={}) {
  let decoded=0,closed=0,removed=0,sourceIndex=0;
  const revoked:string[]=[],qualities:number[]=[],draws:unknown[][]=[],fills:unknown[][]=[];
  const canvas={width:0,height:0,getContext(){return{fillStyle:'',fillRect(...args:unknown[]){fills.push(args);},drawImage(...args:unknown[]){draws.push(args);}};},toBlob(callback:(blob:Blob|null)=>void,type:string,quality:number){assert.equal(type,'image/jpeg');qualities.push(quality);callback(options.emptyCanvas?null:output(options.sizes?.[qualities.length-1]??4));}};
  const bitmap={width:options.width??4000,height:options.height??3000,close(){closed++;}};
  class FakeImage {
    naturalWidth=options.width??4000;naturalHeight=options.height??3000;decoding='';onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
    set src(_value:string){decoded++;queueMicrotask(()=>options.decodeFailure?this.onerror?.():this.onload?.());}
    removeAttribute(name:string){assert.equal(name,'src');removed++;}
  }
  const globals={Uint8Array,Number,Math,String,Error,Blob,Image:FakeImage,URL:{createObjectURL(){return'blob:synthetic-'+(++sourceIndex);},revokeObjectURL(value:string){revoked.push(value);}},document:{createElement(tag:string){assert.equal(tag,'canvas');return canvas;}},btoa:(text:string)=>Buffer.from(text,'binary').toString('base64'),createImageBitmap:options.fallback?undefined:async(_file:File,settings:ImageBitmapOptions)=>{decoded++;assert.equal(settings.imageOrientation,'from-image');return bitmap;}};
  const prepare=runInNewContext('('+prepareNutritionPhoto.toString()+')',globals) as typeof prepareNutritionPhoto;
  return{prepare,qualities,draws,fills,revoked,canvas,get decoded(){return decoded;},get closed(){return closed;},get removed(){return removed;}};
}

test('normalization redraws the image as bounded JPEG instead of copying original metadata',async()=>{
  const f=fixture(),result=await f.prepare(jpeg(4000,3000,'PRIVATE-GPS-EXIF'));
  assert.deepEqual({width:result.width,height:result.height},{width:1600,height:1200});
  assert.equal(result.blob.type,'image/jpeg');assert.equal(f.draws.length,1);assert.deepEqual(f.draws[0].slice(1),[0,0,1600,1200]);assert.deepEqual(f.fills,[[0,0,1600,1200]]);
  assert.equal(f.closed,1);assert.equal(result.dataUrl,'data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64'));
  assert.ok(!result.dataUrl.includes('PRIVATE'));assert.equal(f.revoked.length,0);
});
test('source byte, signature and pixel limits reject before any decoder or canvas work',async()=>{
  const f=fixture();
  await assert.rejects(f.prepare(new File(['<svg/>'],'fake.jpg',{type:'image/jpeg'})),/无法读取/);
  await assert.rejects(f.prepare(png(8000,5000)),/3200 万像素/);
  await assert.rejects(f.prepare({name:'huge.jpg',type:'image/jpeg',size:20*1024*1024+1} as File),/20 MiB/);
  await assert.rejects(f.prepare(new File(['GIF89a'],'animated.gif',{type:'image/gif'})),/暂不支持动图/);
  assert.equal(f.decoded,0);assert.equal(f.draws.length,0);
});
test('decoded dimensions are independently checked and EXIF rotation uses actual oriented dimensions',async()=>{
  const rotated=fixture({width:3000,height:4000}),result=await rotated.prepare(jpeg());
  assert.equal(result.width,1200);assert.equal(result.height,1600);assert.equal(rotated.closed,1);
  const oversized=fixture({width:9000,height:9000});await assert.rejects(oversized.prepare(jpeg()),/像素过大/);assert.equal(oversized.closed,1);assert.equal(oversized.draws.length,0);
});
test('quality is reduced locally until the JPEG fits the bounded request and encoding handles a full-size byte array',async()=>{
  const cap=2*1024*1024,f=fixture({sizes:[cap+1,cap]});const result=await f.prepare(jpeg());
  assert.deepEqual(f.qualities,[0.86,0.76]);assert.equal(result.blob.size,cap);assert.equal(Buffer.from(result.dataUrl.split(',')[1],'base64').length,cap);assert.equal(f.closed,1);
  const tooLarge=fixture({sizes:[cap+1,cap+1,cap+1,cap+1,cap+1]});await assert.rejects(tooLarge.prepare(jpeg()),/仍超过 2 MiB/);assert.equal(tooLarge.closed,1);
});
test('the Image fallback revokes its temporary source URL after success and decode failure',async()=>{
  const f=fixture({fallback:true});const result=await f.prepare(jpeg());assert.equal(result.width,1600);assert.deepEqual(f.revoked,['blob:synthetic-1']);assert.equal(f.removed,1);
  const failure=fixture({fallback:true,decodeFailure:true});await assert.rejects(failure.prepare(jpeg()),/HEIC／HEIF/);assert.deepEqual(failure.revoked,['blob:synthetic-1']);assert.equal(failure.removed,1);
});
test('canvas compression failure closes the decoded bitmap without producing a transferable image',async()=>{
  const f=fixture({emptyCanvas:true});await assert.rejects(f.prepare(jpeg()),/照片压缩失败/);assert.equal(f.closed,1);
});
