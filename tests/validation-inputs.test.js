import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const read=path=>readFileSync(new URL(path,import.meta.url));
test('Committed validation evidence was generated from the current history.json',()=>{
  const sha=createHash('sha256').update(read('../docs/data/history.json')).digest('hex');
  for(const name of ['reference_results','scipy_crosscheck','mean_variance_reference','mean_variance_crosscheck'])
    assert.equal(JSON.parse(read(`../data/validation/${name}.json`)).inputSha256,sha,`${name}.json is stale; rerun scripts/validation (see README)`);
});
test('CLI scripts still run when invoked through a symlinked path',()=>{
  const dir=mkdtempSync(join(tmpdir(),'index-portfolio-cli-'));
  try{
    for(const script of ['calculate-portfolios.mjs','calculate-frontier.mjs']){
      const link=join(dir,script);symlinkSync(fileURLToPath(new URL(`../scripts/${script}`,import.meta.url)),link);
      assert.match(execFileSync(process.execPath,[link,'--help'],{encoding:'utf8'}),/scripts\/calculate-/,script);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
