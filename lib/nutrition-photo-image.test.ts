import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_NUTRITION_PHOTO_BYTES, NutritionPhotoImageError, validateNutritionPhotoDataUrl } from './nutrition-photo-image.ts';
import { TINY_JPEG_DATA_URL } from '../tests/fixtures/nutrition-photo.ts';

const PREFIX='data:image/jpeg;base64,';
const decode=(url=TINY_JPEG_DATA_URL)=>Uint8Array.from(atob(url.slice(PREFIX.length)),(char)=>char.charCodeAt(0));
const encode=(bytes:Uint8Array)=>PREFIX+Buffer.from(bytes).toString('base64');
function concat(...parts:Uint8Array[]){const output=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));let cursor=0;for(const part of parts){output.set(part,cursor);cursor+=part.length;}return output;}
function segment(marker:number,text:string){const payload=new TextEncoder().encode(text),length=payload.length+2;return concat(Uint8Array.from([0xff,marker,length>>8,length&255]),payload);}
function marker(bytes:Uint8Array,code:number){for(let index=0;index<bytes.length-1;index++)if(bytes[index]===0xff&&bytes[index+1]===code)return index;throw new Error('Synthetic JPEG marker missing');}
function fails(input:unknown,status=400){assert.throws(()=>validateNutritionPhotoDataUrl(input),(error:unknown)=>error instanceof NutritionPhotoImageError&&error.status===status&&!error.message.includes('base64')&&!error.message.includes('PRIVATE_'));}

test('an actual JPEG is accepted without rewriting its raster or safe thumbnail-free JFIF',()=>{
  const result=validateNutritionPhotoDataUrl(TINY_JPEG_DATA_URL);
  assert.deepEqual(result,{dataUrl:TINY_JPEG_DATA_URL,width:1,height:1,byteLength:631});
});

test('EXIF, XMP, IPTC, ICC and comments are removed both before and after scan data',()=>{
  const image=decode(),metadata=[segment(0xe1,'Exif\0\0PRIVATE_GPS_COORDINATES'),segment(0xe1,'http://ns.adobe.com/xap/1.0/\0PRIVATE_XMP'),segment(0xed,'Photoshop 3.0\0PRIVATE_IPTC'),segment(0xe2,'ICC_PROFILE\0PRIVATE_PROFILE'),segment(0xfe,'PRIVATE_CAMERA_COMMENT')];
  const wrapped=concat(image.subarray(0,2),...metadata,image.subarray(2,image.length-2),segment(0xfe,'PRIVATE_LATE_COMMENT'),image.subarray(image.length-2));
  const clean=validateNutritionPhotoDataUrl(encode(wrapped));
  assert.equal(clean.dataUrl,TINY_JPEG_DATA_URL);assert.equal(clean.byteLength,631);
  assert.ok(!atob(clean.dataUrl.slice(PREFIX.length)).includes('PRIVATE_'));
});

test('application data and JFIF thumbnails never travel as hidden secondary images',()=>{
  const image=decode(),app0=marker(image,0xe0),length=image[app0+2]*256+image[app0+3];
  const thumbnailFree=concat(image.subarray(0,app0),image.subarray(app0+2+length));
  const unknown=concat(image.subarray(0,2),segment(0xe0,'PRIVATE_UNKNOWN_APP0'),segment(0xee,'PRIVATE_ADOBE'),image.subarray(2));
  assert.equal(validateNutritionPhotoDataUrl(encode(unknown)).dataUrl,TINY_JPEG_DATA_URL);
  const withThumbnail=image.slice();withThumbnail[app0+2+length-2]=1;
  assert.equal(validateNutritionPhotoDataUrl(encode(withThumbnail)).dataUrl,encode(thumbnailFree));
});

test('progressive JPEG scans and scan-local Huffman tables remain readable',()=>{
  const progressive=PREFIX+'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAEBf/aAAwDAQACEAMQAAABlg0H/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
  const result=validateNutritionPhotoDataUrl(progressive);assert.equal(result.width,8);assert.equal(result.height,8);assert.equal(result.dataUrl,progressive);
});

test('only canonical bounded JPEG data URIs are accepted',()=>{
  for(const value of [null,{},'',TINY_JPEG_DATA_URL.replace('image/jpeg','image/png'),TINY_JPEG_DATA_URL.replace('image/jpeg','image/jpg'),'https://example.com/food.jpg',PREFIX+'PHN2Zz48L3N2Zz4=',TINY_JPEG_DATA_URL+'\n',TINY_JPEG_DATA_URL.replace(/Q==$/,'R=='),TINY_JPEG_DATA_URL.slice(0,-1)])fails(value);
  fails(PREFIX+'A'.repeat(Math.ceil(MAX_NUTRITION_PHOTO_BYTES/3)*4+4),413);
  fails(encode(new Uint8Array(MAX_NUTRITION_PHOTO_BYTES+1)),413);
});

test('malformed marker lengths, scans, frames and trailing polyglot content are rejected',()=>{
  const original=decode(),sof=marker(original,0xc0),sos=marker(original,0xda),dqt=marker(original,0xdb),dht=marker(original,0xc4);
  const mutations=[
    (bytes:Uint8Array)=>{bytes[0]=0;},
    (bytes:Uint8Array)=>{bytes[sof+1]=0xc3;},
    (bytes:Uint8Array)=>{bytes[sof+2]=0;bytes[sof+3]=1;},
    (bytes:Uint8Array)=>{bytes[sof+5]=0;bytes[sof+6]=0;},
    (bytes:Uint8Array)=>{bytes[sof+7]=8;bytes[sof+8]=1;},
    (bytes:Uint8Array)=>{bytes[sof+4]=12;},
    (bytes:Uint8Array)=>{bytes[sos+5]=0x7f;},
    (bytes:Uint8Array)=>{bytes[dqt+4]=0x20;},
    (bytes:Uint8Array)=>{bytes[dqt+5]=0;},
    (bytes:Uint8Array)=>{bytes[dht+5]=3;},
  ];
  for(const change of mutations){const changed=original.slice();change(changed);fails(encode(changed));}
  fails(encode(original.subarray(0,original.length-1)));
  fails(encode(concat(original,new TextEncoder().encode('<script>PRIVATE_PAYLOAD</script>'))));
  const scanEnd=sos+2+original[sos+2]*256+original[sos+3];
  fails(encode(concat(original.subarray(0,scanEnd),original.subarray(original.length-2))));
  fails(encode(concat(original.subarray(0,sos),Uint8Array.from([0xff,0xda,0,8,1,1,0,0,63,0]),original.subarray(scanEnd))));
});
