/**
 * Regression guard for .github/workflows/deploy.yml: the production build must receive the Sanity settings from
 * repository variables, stay startable by hand and never handle a Sanity token. Only checks properties that also
 * hold for the automated workflow, so it protects the variables across later workflow changes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('deploy workflow', () => {
  it('can be started manually', () => {
    assert.match(workflow, /^\s+workflow_dispatch:\s*$/m);
  });

  it('passes SANITY_PROJECT_ID and SANITY_DATASET from repository variables', () => {
    assert.match(workflow, /SANITY_PROJECT_ID: \$\{\{ vars\.SANITY_PROJECT_ID \}\}/);
    assert.match(workflow, /SANITY_DATASET: \$\{\{ vars\.SANITY_DATASET \}\}/);
  });

  it('uses no Sanity token and no secret besides the built-in GITHUB_TOKEN', () => {
    assert.doesNotMatch(workflow, /SANITY_READ_TOKEN|SANITY_.*TOKEN/);
    assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN']);
  });

  it('never exposes Sanity settings with a client-side prefix', () => {
    assert.doesNotMatch(workflow, /PUBLIC_SANITY|PUBLIC_\w*TOKEN/);
  });
});
