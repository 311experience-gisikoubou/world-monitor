#!/usr/bin/env node
import { access, copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeCanonicalContract } from './canonical-contract-gate.mjs';
import { normalizeUiReferenceRegistry, UI_REFERENCE_REGISTRY } from './ui-reference-registry.mjs';

function out(ok,code,detail={}){return {ok,code,...detail};}
async function exists(p){try{await access(p,fsConstants.F_OK);return true;}catch{return false;}}
function arg(args,name){const i=args.indexOf(name);if(i<0)return null;if(!args[i+1])throw new Error(name+'_VALUE_REQUIRED');return args[i+1];}
function safeView(v){return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(v)?v:null;}
function safeFilePart(v){return String(v).replace(/[<>:"\/\\|?*\u0000-\u001f]/gu,'_');}
function isoDate(v){const s=v??new Date().toISOString().slice(0,10);return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(s)?s:null;}
function nullableNumber(v,min,max){if(v==null)return null;const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max?n:undefined;}
function parseViewport(v){
  if(v==null||v==='unknown')return null;
  const m=String(v).match(/^(\d{2,5})x(\d{2,5})$/u);
  if(!m)return undefined;
  const width=Number(m[1]),height=Number(m[2]);
  return width>=200&&width<=10000&&height>=200&&height<=10000?{width,height}:undefined;
}
function git(root,args){return spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});}
function featureBranch(root){
  const r=git(root,['branch','--show-current']);const b=String(r.stdout??'').trim();
  if(r.error||r.status!==0||!b||['main','master','trunk'].includes(b))return null;
  return b;
}
function relInside(root,path){
  const rel=relative(root,path).replaceAll('\\','/');
  return !rel.startsWith('../')&&!isAbsolute(rel)?rel:null;
}
async function loadRegistry(root){
  const path=join(root,...UI_REFERENCE_REGISTRY.split('/'));
  if(!await exists(path))return {path,value:{schemaVersion:1,references:[]}};
  const parsed=JSON.parse(await readFile(path,'utf8'));const n=normalizeUiReferenceRegistry(parsed);
  if(n.error)throw new Error(n.error.code);
  return {path,value:n.value};
}
export async function adoptUiReference({root,artifactId,viewId,image,approvedAt,viewport,browserZoom,devicePixelRatio,browser,fontFamily}){
  root=resolve(root);image=resolve(image);
  const branch=featureBranch(root);if(!branch)return out(false,'UI_REFERENCE_FEATURE_BRANCH_REQUIRED');
  const sourceRel=relInside(root,image);if(!await exists(image))return out(false,'UI_REFERENCE_SOURCE_IMAGE_MISSING');
  const ext=extname(image).toLowerCase();if(!['.png','.jpg','.jpeg','.webp'].includes(ext))return out(false,'UI_REFERENCE_IMAGE_TYPE_INVALID');
  const manifestPath=join(root,'PROJECT_CONTEXT.json');let manifest;
  try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{return out(false,'UI_REFERENCE_PROJECT_CONTEXT_INVALID');}
  const contract=normalizeCanonicalContract(manifest);if(contract.error)return out(false,contract.error.code);
  const artifact=contract.byId.get(artifactId);
  if(!artifact||artifact.status!=='CURRENT'||artifact.kind!=='DESIGN'||artifact.visual?.baseline!=='REFERENCE_IMAGE')
    return out(false,'UI_REFERENCE_CURRENT_ARTIFACT_REQUIRED');
  if(!artifact.visual.scope.includes(viewId))return out(false,'UI_REFERENCE_VIEW_OUTSIDE_SCOPE',{scope:artifact.visual.scope});
  const loaded=await loadRegistry(root);const registry=loaded.value;
  const existing=registry.references.find(row=>row.viewId===viewId)??null;
  const currentDir=join(root,'docs','ui-reference','current'),archiveDir=join(root,'docs','ui-reference','archive',viewId);
  await mkdir(currentDir,{recursive:true});await mkdir(archiveDir,{recursive:true});
  const destination=join(currentDir,viewId+ext);if(resolve(image).toLowerCase()===resolve(destination).toLowerCase())return out(false,'UI_REFERENCE_SOURCE_EQUALS_DESTINATION');
  if(existing){
    const oldPath=resolve(root,...existing.image.split('/'));
    if(await exists(oldPath)){
      const oldExt=extname(oldPath).toLowerCase();const archiveName=safeFilePart(existing.approvedAt)+'__'+safeFilePart(existing.artifactId)+oldExt;
      await copyFile(oldPath,join(archiveDir,archiveName));
      if(resolve(oldPath).toLowerCase()!==resolve(destination).toLowerCase())await unlink(oldPath);
    }
  }
  await copyFile(image,destination);
  const row={artifactId,viewId,image:relInside(root,destination),approvedAt,viewport,browserZoom,devicePixelRatio,browser,fontFamily};
  const next={schemaVersion:1,references:[...registry.references.filter(x=>x.viewId!==viewId),row]};
  const normalized=normalizeUiReferenceRegistry(next);if(normalized.error)return out(false,normalized.error.code);
  await mkdir(dirname(loaded.path),{recursive:true});await writeFile(loaded.path,JSON.stringify(normalized.value,null,2)+'\n','utf8');
  const requiredArtifactSources=[UI_REFERENCE_REGISTRY,...normalized.value.references.filter(x=>x.artifactId===artifactId).map(x=>x.image)].sort();
  const actual=[...artifact.sources].sort();const sourceUpdateRequired=JSON.stringify(actual)!==JSON.stringify(requiredArtifactSources);
  return out(true,'UI_REFERENCE_ADOPTED',{branch,viewId,artifactId,currentImage:row.image,archivedPrevious:Boolean(existing),sourceImageWasInsideRepository:Boolean(sourceRel),registry:UI_REFERENCE_REGISTRY,requiredArtifactSources,sourceUpdateRequired});
}
async function main(){
  try{
    const args=process.argv.slice(2),allowed=new Set(['--root','--artifact-id','--view-id','--image','--approved-at','--viewport','--browser','--zoom','--dpr','--font-family','--pretty']);
    for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error('ARGUMENT_INVALID');if(args[i]!=='--pretty')i++;}
    const root=arg(args,'--root')??process.cwd(),artifactId=arg(args,'--artifact-id'),viewId=safeView(arg(args,'--view-id')),image=arg(args,'--image');
    const approvedAt=isoDate(arg(args,'--approved-at')),viewport=parseViewport(arg(args,'--viewport'));
    const browserZoom=nullableNumber(arg(args,'--zoom'),25,500),devicePixelRatio=nullableNumber(arg(args,'--dpr'),0.25,8);
    const browser=arg(args,'--browser')??null,fontFamily=arg(args,'--font-family')??null,pretty=args.includes('--pretty');
    if(!artifactId||!viewId||!image||!approvedAt||viewport===undefined||browserZoom===undefined||devicePixelRatio===undefined)throw new Error('ARGUMENT_INVALID');
    const result=await adoptUiReference({root,artifactId,viewId,image,approvedAt,viewport,browserZoom,devicePixelRatio,browser,fontFamily});
    console.log(JSON.stringify(result,null,pretty?2:0));if(!result.ok)process.exitCode=2;
  }catch(e){console.log(JSON.stringify(out(false,'UI_REFERENCE_MANAGER_ERROR',{message:e?.message??'unknown'}),null,2));process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
