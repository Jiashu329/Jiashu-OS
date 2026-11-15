import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUIRED_WORKFLOWS, selectSuccessfulRuns } from './check-ci.mjs';

const sha='a'.repeat(40), repository='owner/repository';
const successful=()=>REQUIRED_WORKFLOWS.map((name,index)=>({id:index+1,name,event:'push',head_branch:'main',head_sha:sha,head_repository:{full_name:repository},status:'completed',conclusion:'success'}));
void test('deployment requires all four successful checks for the exact trusted main commit',()=>{
  assert.equal(selectSuccessfulRuns(successful(),sha,repository),true);
  assert.equal(selectSuccessfulRuns(successful().slice(0,3),sha,repository),false);
  for(const patch of [{head_sha:'b'.repeat(40)},{event:'pull_request'},{head_branch:'feature'},{head_repository:{full_name:'fork/repository'}},{status:'in_progress'},{conclusion:'failure'}]){
    const rows=successful();rows[0]={...rows[0],...patch};assert.equal(selectSuccessfulRuns(rows,sha,repository),false);
  }
});
void test('a newer failed or running attempt cannot be hidden by an earlier success',()=>{
  const rows=successful();rows.push({...rows[0],id:100,status:'in_progress',conclusion:null});
  assert.equal(selectSuccessfulRuns(rows,sha,repository),false);
  rows.at(-1).status='completed';rows.at(-1).conclusion='failure';assert.equal(selectSuccessfulRuns(rows,sha,repository),false);
  rows.at(-1).conclusion='success';assert.equal(selectSuccessfulRuns(rows,sha,repository),true);
});
void test('remote argument validators reject shell injection, unsafe roots and non-HTTPS origins',()=>{
  const common=new URL('./common.sh',import.meta.url).pathname;
  const run=(call,value)=>spawnSync('bash',['-c','source "$1"; "$2" "$3"','test',common,call,value],{encoding:'utf8'}).status;
  assert.equal(run('validate_app_dir','/opt/jiashu-test'),0);
  for(const value of ['/','/opt','/tmp/app','/opt/../etc','/opt/app;id','/opt//app','/opt/app/'])assert.notEqual(run('validate_app_dir',value),0);
  assert.equal(run('validate_origin','https://www.treefund.asia'),0);
  for(const value of ['http://example.test','https://user@example.test','https://example.test/path','https://example.test;id'])assert.notEqual(run('validate_origin',value),0);
  assert.equal(run('validate_port','3100'),0);assert.notEqual(run('validate_port','80'),0);assert.notEqual(run('validate_port','65536'),0);
});
void test('real ERR recovery runs through compose helper failures and restores only a compatible prior image',()=>{
  const directory=mkdtempSync(join(tmpdir(),'jiashu-recovery-'));
  try{
    const app=join(directory,'app'), release=join(directory,'release');mkdirSync(app);mkdirSync(release);
    const source=readFileSync(new URL('./deploy.sh',import.meta.url),'utf8');
    assert.match(source,/set -Eeuo pipefail/);
    const handler=source.match(/finish_on_error\(\) \{[\s\S]*?\n\}\ntrap finish_on_error ERR/)[0];
    for(const [phase,changed,shouldRestore] of [['migrated','false',true],['migrating','true',false]]){
      writeFileSync(join(release,'previous.env'),'PREVIOUS\n');writeFileSync(join(release,'previous-compose.yml'),'PREVIOUS_COMPOSE\n');
      writeFileSync(join(app,'current.env'),'CANDIDATE\n');writeFileSync(join(app,'compose.yml'),'CANDIDATE_COMPOSE\n');
      const program=`set -Eeuo pipefail\nsource "$1"\napp_dir=$2;release_dir=$3;current_env="$app_dir/current.env";candidate_env="$app_dir/candidate.env"\nprevious_image=sha256:${'a'.repeat(64)};previous_sha=${sha};previous_port=3100;image_id=sha256:${'b'.repeat(64)};phase=$4;migrations_changed=$5\ndocker(){ if [[ "$*" == *candidate.env* ]];then return 17;fi;return 0; }\nwait_ready(){ return 0; }\n${handler}\ncompose "$candidate_env" up -d --no-deps app\n`;
      const result=spawnSync('bash',['-c',program,'test',new URL('./common.sh',import.meta.url).pathname,app,release,phase,changed],{encoding:'utf8'});
      assert.equal(result.status,17);
      assert.equal(readFileSync(join(app,'current.env'),'utf8'),shouldRestore?'PREVIOUS\n':'CANDIDATE\n');
      assert.match(result.stderr,shouldRestore ? /previous compatible application image restored/ : /Database was not restored or downgraded/);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
