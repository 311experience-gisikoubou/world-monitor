#!/usr/bin/env node
const ID_RE=/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/u;
const VIEW_RE=/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const IMAGE_RE=/\.(?:png|jpe?g|webp)$/iu;
export const UI_REFERENCE_REGISTRY='docs/ui-reference/CURRENT.json';

function obj(v){return Boolean(v)&&typeof v==='object'&&!Array.isArray(v);}
function text(v,max=500){return typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v)?v:null;}
function id(v){const s=text(v,160);return s&&ID_RE.test(s)?s:null;}
function view(v){const s=text(v,80);return s&&VIEW_RE.test(s)?s:null;}
function nullableText(v,max=300){if(v===null)return null;return text(v,max);}
function exact(o,keys){return obj(o)&&Object.keys(o).length===keys.length&&Object.keys(o).every(k=>keys.includes(k));}
function repoPath(v){
  const s=text(v,500);
  if(!s||s.startsWith('/')||s.startsWith('\\')||s.includes('\\')||/^[A-Za-z]:/u.test(s))return null;
  if(s.split('/').includes('..')||!s.startsWith('docs/ui-reference/current/')||!IMAGE_RE.test(s))return null;
  return s;
}
function approvedAt(v){
  const s=text(v,40);
  return s&&/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(s)?s:null;
}
function numberOrNull(v,min,max){
  if(v===null)return null;
  return typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:undefined;
}
function viewport(v){
  if(v===null)return null;
  if(!exact(v,['width','height']))return undefined;
  const width=Number.isInteger(v.width)&&v.width>=200&&v.width<=10000?v.width:null;
  const height=Number.isInteger(v.height)&&v.height>=200&&v.height<=10000?v.height:null;
  return width&&height?{width,height}:undefined;
}
function normalizeRow(raw){
  const keys=['artifactId','viewId','image','approvedAt','viewport','browserZoom','devicePixelRatio','browser','fontFamily'];
  if(!exact(raw,keys))return null;
  const artifactId=id(raw.artifactId),viewId=view(raw.viewId),image=repoPath(raw.image),date=approvedAt(raw.approvedAt);
  const vp=viewport(raw.viewport),zoom=numberOrNull(raw.browserZoom,25,500),dpr=numberOrNull(raw.devicePixelRatio,0.25,8);
  const browser=nullableText(raw.browser,200),fontFamily=nullableText(raw.fontFamily,300);
  if(!artifactId||!viewId||!image||!date||vp===undefined||zoom===undefined||dpr===undefined||browser===undefined||fontFamily===undefined)return null;
  return {artifactId,viewId,image,approvedAt:date,viewport:vp,browserZoom:zoom,devicePixelRatio:dpr,browser,fontFamily};
}
export function normalizeUiReferenceRegistry(raw){
  if(!exact(raw,['schemaVersion','references'])||raw.schemaVersion!==1||!Array.isArray(raw.references)||raw.references.length>100)
    return {error:{code:'UI_REFERENCE_REGISTRY_INVALID',message:'CURRENT.json must use the closed schemaVersion=1 shape.'}};
  const references=[],pairs=new Set(),images=new Set(),views=new Set();
  for(const item of raw.references){
    const row=normalizeRow(item);
    if(!row)return {error:{code:'UI_REFERENCE_ENTRY_INVALID',message:'CURRENT.json contains an invalid UI reference entry.'}};
    const pair=row.artifactId+'\0'+row.viewId;
    if(pairs.has(pair)||images.has(row.image)||views.has(row.viewId))
      return {error:{code:'UI_REFERENCE_DUPLICATE',message:'artifact/view, viewId, and current image paths must be unique.'}};
    pairs.add(pair);images.add(row.image);views.add(row.viewId);references.push(row);
  }
  references.sort((a,b)=>a.viewId.localeCompare(b.viewId)||a.artifactId.localeCompare(b.artifactId));
  return {value:{schemaVersion:1,references}};
}
export function referencesForArtifact(registry,artifactId){
  return registry.references.filter(row=>row.artifactId===artifactId).sort((a,b)=>a.viewId.localeCompare(b.viewId));
}
