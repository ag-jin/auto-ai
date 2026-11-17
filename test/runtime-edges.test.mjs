import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import {Runtime} from '../src/runtime.mjs';
import {Workflow} from '../src/workflow.mjs';

const appRepoDir=fileURLToPath(new URL('..',import.meta.url));
const repo='fixture/repo';
const id=`${repo}#1`;
const headSha='c'.repeat(40);
const mergeSha='d'.repeat(40);
const issue={repo,number:1,title:'fixture',body:'fixture',state:'open',author:'fixture',labels:[],updatedAt:'2026-11-17T00:00:00Z',url:`https://github.com/${repo}/issues/1`};
const settings={repositories:[{repo,localPath:'',baseRef:'HEAD'}],rules:{repositories:[repo],states:['open']},concurrency:{global:1,perRepo:1}};
function gate(){let release;const promise=new Promise(resolve=>{release=resolve;});return{promise,release};}

async function accepted(t,{events=0}={}){
 const dataDir=await mkdtemp(path.join(tmpdir(),'auto-ai-edge-'));
 const wf=new Workflow({dbPath:path.join(dataDir,'workflow.db')});
 wf.saveSettings({...settings,repositories:[{repo,localPath:dataDir,baseRef:'HEAD'}]});
 wf.collect([issue]);
 const c=wf.saveDraft(id,{goal:'fixture',acceptance:['fixture'],writeScopes:['NOTE.md']});
 wf.decide(id,{action:'develop',draftRev:c.draft.rev,actor:'user'});
 const run=wf.claimNext();
 wf.bindExecution(run.id,{templateRef:'a'.repeat(40)+':templates/development/1.2.0.md',branch:'fixture',worktreePath:dataDir});
 wf.finishRun(run.id,{summary:'fixture',artifacts:[],evidence:[],pr:{repo,number:2,url:`https://github.com/${repo}/pull/2`,headSha}});
 for(const role of ['user','design'])wf.recordAcceptance(id,{role,verdict:'approved',headSha,comment:'fixture accepted'});
 for(let index=0;index<events;index++)wf.recordEvent({kind:'fixture.marker',message:`marker-${index}`});
 wf.close();
 const state={merged:false,mutations:0,onMerge:async()=>({merged:false,pending:true,note:'fixture pending'})};
 const github={async checkReady(){return{ready:true};},async readIssue(){await delay(5);return issue;},async readPullRequest(){return{repo,number:2,headSha,state:state.merged?'merged':'open',mergeSha:state.merged?mergeSha:null};},async mergePullRequest(){state.mutations++;return state.onMerge();}};
 const options={dataDir,appRepoDir,github,pi:{},workspace:{},tickMs:600000};
 let runtime=new Runtime(options);
 t.after(async()=>{await runtime.close();await rm(dataDir,{recursive:true,force:true});});
 await runtime.start();
 return {get runtime(){return runtime;},dataDir,state,async restart(){await runtime.close();runtime=new Runtime(options);await runtime.start();}};
}
const mergeInput={expectedHeadSha:headSha,confirmed:true,method:'squash'};

test('状态事件窗口包含最新事件而不永远停留在最早 300 条',async t=>{
 const env=await accepted(t,{events:350});
 const state=await env.runtime.getState();
 assert.equal(state.events.length,300);
 assert.equal(state.events.at(-1).message,'marker-349');
});

test('关闭等待在途收集，持锁收尾且不会在关闭后调用模型',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'auto-ai-close-edge-'));
 const entered=gate(),release=gate();let spawns=0;
 const github={async checkReady(){return{ready:true};},async collectIssues(){entered.release();await release.promise;return[issue];}};
 const pi={async list(){return[];},async start({id}){spawns++;return{id,state:'running',sessionId:'fixture'};},async status(){return{state:'running',progress:[]};}};
 const options={dataDir,appRepoDir,github,pi,workspace:{},tickMs:600000};
 const runtime=new Runtime(options),contender=new Runtime(options);
 let collection,closing;
 try{
  await runtime.start();await runtime.saveSettings(settings);
  collection=runtime.collect().then(()=>null,error=>error);
  await entered.promise;closing=runtime.close();await delay(10);
  await assert.rejects(contender.start(),error=>error.statusCode===409);
  release.release();
  assert.equal(await collection,null);
  await closing;
  assert.equal(spawns,0);
  await contender.start();
 }finally{
  release.release();await Promise.allSettled([collection,closing].filter(Boolean));
  await contender.close();await runtime.close();await rm(dataDir,{recursive:true,force:true});
 }
});

test('Runtime 拒绝相对数据路径和模板仓库路径',()=>{
 assert.throws(()=>new Runtime({dataDir:'relative',appRepoDir}),/绝对路径/);
 assert.throws(()=>new Runtime({dataDir:tmpdir(),appRepoDir:'relative'}),/绝对路径/);
});
