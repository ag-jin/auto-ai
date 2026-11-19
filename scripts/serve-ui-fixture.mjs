// Explicit local acceptance fixture. Never imported by production startup.
import {Runtime} from '../src/runtime.mjs';
import {WorkspaceAdapter} from '../src/workspace-adapter.mjs';
import {createHttpServer} from '../src/http-server.mjs';
import {writeJsonAtomic,readJsonFile,describeProcess} from '../src/pi-adapter.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,access,readdir} from 'node:fs/promises';
import {readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const hub=fileURLToPath(new URL('..',import.meta.url));
const activeFile=path.join(hub,'.auto-ai/ui-full-active.json');
const existing=readJsonFile(activeFile);
if(existing&&existing.status!=='closed')throw new Error('已有验收现场，请先核对 ui-full-active.json 并完成清理；不重复创建服务');
const exec=promisify(execFile);
const gitEnv={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
const git=async(cwd,args)=>(await exec('git',['-C',cwd,...args],{env:gitEnv})).stdout.trim();
const root=await mkdtemp(path.join(tmpdir(),'auto-ai-ui-full-'));
const evidence=path.join(hub,'.auto-ai/validation','ui-full-'+Date.now());
mkdirSync(evidence,{recursive:true});
const dataDir=path.join(evidence,'data');
const controlFile=path.join(evidence,'control.json');
writeJsonAtomic(controlFile,{completeDrafts:[],completeRuns:[],failRuns:[],mergeState:'open'});
const control=()=>JSON.parse(readFileSync(controlFile,'utf8'));
const stats={fixtureOnly:true,piStarts:[],prCreates:[],mergeCalls:[],cancelCalls:[]};
const saveStats=()=>writeJsonAtomic(path.join(evidence,'stats.json'),stats);
const repoA='fixture-owner/ui-one',repoB='fixture-owner/ui-two';
const spec=(repo,number,title,file,extra={})=>({repo,number,title:'隔离验收：'+title,body:`仅创建 ${file}，内容严格为 ui-smoke。此为隔离验收替身，不对应真实 GitHub Issue。`,state:'open',author:'fixture',labels:['ready'],updatedAt:'2026-11-18T00:00:00Z',url:`https://github.com/${repo}/issues/${number}`,isPullRequest:false,file,...extra});
const issues=[
 spec(repoA,101,'审阅任务稿后开发','NOTE.md',{pending:true}),
 spec(repoA,102,'整理中忽略','IGNORE.md',{holdDraft:true}),
 spec(repoB,201,'整理中暂缓','DEFER.md',{holdDraft:true}),
 spec(repoB,202,'阻塞与重试','docs/NOTE.md'),
 spec(repoA,103,'同仓冲突与跨仓依赖排队','NOTE.md',{dependsOn:[`${repoB}#202`]}),
 spec(repoB,299,'规则排除','EXCLUDED.md',{labels:['parked']}),
];
const sources=new Map(),remotes=new Map();
for(const repo of [repoA,repoB]){
 const source=path.join(root,'sources',repo.split('/')[1]);
 const remote=path.join(root,'remotes',repo+'.git');
 await mkdir(source,{recursive:true});await mkdir(path.dirname(remote),{recursive:true});
 await git(root,['init','--bare',remote]);await git(source,['init','-b','main']);
 await git(source,['config','user.email','ui-fixture@example.invalid']);await git(source,['config','user.name','UI Acceptance Fixture']);
 await writeFile(path.join(source,'README.md'),'isolated UI acceptance\n');await git(source,['add','README.md']);await git(source,['commit','-m','fixture baseline']);
 await git(source,['remote','add','origin',remote]);await git(source,['push','-u','origin','main']);
 sources.set(repo,source);remotes.set(repo,remote);
}
const runs=new Map(),prs=new Map();
const draftFor=issue=>({templateId:'development',goal:`创建 ${issue.file} 并验证精确内容`,scope:`仅 ${issue.file}`,acceptance:[`${issue.file} 存在且内容严格等于 ui-smoke`],context:'明确的隔离 UI 验收任务；GitHub 与 Pi 为显式替身，Git 操作为真实临时仓库。',pendingDecisions:issue.pending?['确认此测试文件使用 ui-smoke 内容']:[],writeScopes:[issue.file],dependsOn:issue.dependsOn??[],priority:0});
const pi={
 async start(input){
  let issue;
  if(input.role==='draft'){
   const match=/```json\n([\s\S]*?)\n```/.exec(input.prompt);assert.ok(match,'Issue JSON present');
   const item=JSON.parse(match[1]);issue=issues.find(x=>x.repo===item.repo&&x.number===item.number);
  }else{
   const packet=JSON.parse(await readFile(path.join(dataDir,'runs',input.id,'packet.json'),'utf8'));
   issue=issues.find(x=>`${x.repo}#${x.number}`===packet.issue_ref);
  }
  assert.ok(issue,'known isolated issue');
  const record={id:input.id,role:input.role,cwd:input.cwd,issue,sessionId:'fixture-'+input.id,state:'running',at:new Date().toISOString(),output:null};
  runs.set(input.id,record);stats.piStarts.push({id:record.id,role:record.role,candidateId:`${issue.repo}#${issue.number}`,cwd:record.cwd,sessionId:record.sessionId});saveStats();
  return{id:record.id,state:'running',sessionId:record.sessionId,monitorPid:null};
 },
 async status(id){
  const r=runs.get(id);assert.ok(r,`known Pi fixture ${id}`);const c=control();
  if(r.state==='running'&&r.role==='draft'&&(!r.issue.holdDraft||c.completeDrafts.includes(`${r.issue.repo}#${r.issue.number}`))){r.state='completed';r.output=JSON.stringify(draftFor(r.issue));}
  if(r.state==='running'&&r.role==='worker'){
   if(c.failRuns.includes(id)){r.state='failed';r.error='隔离执行器模拟一次检查失败';}
   else if(c.completeRuns.includes(id)){
    const file=path.join(r.cwd,r.issue.file);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,'ui-smoke');
    await exec(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';if(fs.readFileSync(${JSON.stringify(r.issue.file)},'utf8')!=='ui-smoke')process.exit(1)`],{cwd:r.cwd});
    r.state='completed';r.output=JSON.stringify({summary:`隔离验收：新增 ${r.issue.file}`,artifacts:[r.issue.file],evidence:[{command:'node exact-file-content assertion',status:'passed',detail:'真实本地 Node 检查退出 0；执行器为测试替身'}],blockers:[]});
   }
  }
  return{id:r.id,state:r.state,sessionId:r.sessionId,monitorPid:null,dir:path.join(dataDir,'fixture-pi',id),output:r.output,error:r.error??null,exitCode:r.state==='completed'?0:null,progress:[{at:r.at,phase:'worker',message:'显式隔离执行器；未调用真实模型'}]};
 },
 async list(){return Promise.all([...runs.keys()].map(id=>this.status(id)));},
 async cancel(id){const r=runs.get(id);assert.ok(r);r.state='cancelled';stats.cancelCalls.push(id);saveStats();return this.status(id);},
};
const github={
 async checkReady(){return{ready:true,reason:'隔离 GitHub 替身，未连接真实网络'};},
 async collectIssues(repo){return issues.filter(x=>x.repo===repo).map(x=>({...x}));},
 async readIssue({repo,number}){const issue=issues.find(x=>x.repo===repo&&x.number===number);assert.ok(issue);return{...issue};},
 async createPullRequest(input){
  let pr=[...prs.values()].find(pr=>pr.repo===input.repo&&pr.branch===input.branch);
  if(!pr){const headSha=(await git(sources.get(input.repo),['ls-remote','--heads','origin',`refs/heads/${input.branch}`])).split(/\s+/)[0];assert.match(headSha,/^[0-9a-f]{40}$/);
   const number=801+prs.size;pr={repo:input.repo,number,url:`https://github.com/${input.repo}/pull/${number}`,headSha,branch:input.branch};prs.set(`${pr.repo}#${number}`,pr);stats.prCreates.push(pr);saveStats();}
  return{...pr};
 },
 async readPullRequest({repo,number}){const pr=prs.get(`${repo}#${number}`);assert.ok(pr);const merged=control().mergeState==='merged'&&stats.mergeCalls.some(m=>m.repo===repo&&m.number===number);return{...pr,state:merged?'merged':'open',mergeSha:merged?'a'.repeat(40):null,mergeable:'MERGEABLE',checks:[]};},
 async mergePullRequest(input){stats.mergeCalls.push({...input});saveStats();return{merged:false,pending:true,note:'隔离替身暂未确认 MERGED，等待只读核验'};},
};
const workspace=new WorkspaceAdapter({rootDir:path.join(dataDir,'workspace'),run:(cmd,args,opts={})=>exec(cmd,args,{...opts,env:gitEnv})});
const runtime=new Runtime({dataDir,appRepoDir:hub,github,pi,workspace,tickMs:200});
const publicDir=path.join(evidence,'public');await cp(path.join(hub,'public'),publicDir,{recursive:true});
const html=await readFile(path.join(publicDir,'index.html'),'utf8');await writeFile(path.join(publicDir,'index.html'),html.replace('<title>','<title>【隔离验收】'));
const app=await createHttpServer({runtime,port:0,publicDir});
await runtime.saveSettings({repositories:[repoA,repoB].map(repo=>({repo,localPath:sources.get(repo),baseRef:'main'})),rules:{repositories:[repoA,repoB],labels:['ready'],authors:[],keywords:[],states:['open']},concurrency:{global:2,perRepo:2}});
const metadata={fixtureOnly:true,status:'running',identity:describeProcess(process.pid),pid:process.pid,url:app.url,root,evidence,dataDir,controlFile,createdAt:new Date().toISOString(),sources:Object.fromEntries(sources),remotes:Object.fromEntries(remotes)};
writeJsonAtomic(activeFile,metadata);saveStats();console.log(JSON.stringify(metadata));
let closing=false;
const stop=async()=>{
 if(closing)return;
 closing=true;
 let state=null;
 const cleanup={removedWorktrees:[],preservedWorktrees:[],gitBundles:[],errors:[]};
 try{state=await runtime.getState();}catch(error){cleanup.errors.push(error.message);}
 await app.close();
 if(state)writeJsonAtomic(path.join(evidence,'final-backend.json'),state);
 writeJsonAtomic(path.join(evidence,'final-stats.json'),stats);
 try{
  for(const[repo,source]of sources){
   const dest=path.join(evidence,repo.replace('/','-')+'.bundle');
   await git(source,['bundle','create',dest,'--all']);cleanup.gitBundles.push(dest);
  }
  for(const run of state?.runs??[]){
   if(!run.worktreePath)continue;
   try{await access(run.worktreePath);}catch{continue;}
   assert.ok(run.worktreePath.startsWith(path.join(dataDir,'workspace','worktrees')+path.sep));
   const dirty=await git(run.worktreePath,['status','--porcelain']);
   if(dirty){cleanup.preservedWorktrees.push(run.worktreePath);continue;}
   await git(sources.get(run.repo),['worktree','remove',run.worktreePath]);
   cleanup.removedWorktrees.push(run.worktreePath);
  }
  const treeRoot=path.join(dataDir,'workspace','worktrees');
  let remaining=[];
  try{remaining=await readdir(treeRoot);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of remaining){const file=path.join(treeRoot,name);if(!cleanup.preservedWorktrees.includes(file))cleanup.preservedWorktrees.push(file);}
  if(state&&!cleanup.preservedWorktrees.length){await rm(root,{recursive:true,force:true});cleanup.temporaryRootRemoved=true;}
 }catch(error){cleanup.errors.push(error.message);}
 writeJsonAtomic(path.join(evidence,'cleanup.json'),cleanup);
 writeJsonAtomic(activeFile,{...metadata,status:'closed',cleanup});
 if(cleanup.errors.length||cleanup.preservedWorktrees.length)process.exitCode=1;
 console.log(JSON.stringify({status:'UI_FIXTURE_STOPPED',evidence,cleanup}));
};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
