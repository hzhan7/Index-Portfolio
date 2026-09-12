import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/compute.mjs', import.meta.url));
const run = (script, args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('compute CLI prints a summary when invoked directly', () => {
  assert.match(run(CLI, ['--state', '', '--kinds', 'sample']), /\[sample\]/);
});

test('compute CLI still runs when invoked through a symlinked path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-portfolio-cli-'));
  try {
    const link = join(dir, 'compute.mjs');
    symlinkSync(CLI, link);
    assert.match(run(link, ['--state', '', '--kinds', 'sample']), /\[sample\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
