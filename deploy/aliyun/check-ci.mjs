import { appendFileSync, readFileSync } from 'node:fs';

export const REQUIRED_WORKFLOWS = ['Application checks', 'Browser acceptance', 'Douban extension acceptance', 'Self-hosted checks'];
export function automaticDeploymentEnabled(override, repository, activation) {
  if (override === 'true') return true;
  if (override !== undefined && override !== '') return false;
  return activation !== null && typeof activation === 'object' && !Array.isArray(activation)
    && activation.version === 1 && activation.enabled === true
    && typeof repository === 'string' && repository.length > 0 && activation.repository === repository;
}
export function selectSuccessfulRuns(runs, sha, repository) {
  const latest = new Map();
  for (const run of runs) {
    if (!REQUIRED_WORKFLOWS.includes(run.name) || run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== sha
      || run.head_repository?.full_name !== repository) continue;
    const old = latest.get(run.name);
    if (!old || Number(run.id) > Number(old.id)) latest.set(run.name, run);
  }
  return REQUIRED_WORKFLOWS.every(name => latest.get(name)?.status === 'completed' && latest.get(name)?.conclusion === 'success');
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY, sha = process.env.DEPLOY_SHA;
  const operation = process.env.DEPLOY_OPERATION || 'deploy';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Invalid source identity.');
  if (!['inspect', 'bootstrap', 'deploy'].includes(operation)) throw new Error('Unsupported operation.');
  const output = (ready, reason) => {
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\nsha=${sha}\noperation=${operation}\n`);
    process.stdout.write(reason + '\n');
  };
  if (operation === 'inspect') return output(true, 'Read-only server inspection requested.');
  if (operation === 'bootstrap' && process.env.BOOTSTRAP_CONFIRM !== 'BOOTSTRAP-JIASHU-TEST') throw new Error('Bootstrap requires the exact confirmation BOOTSTRAP-JIASHU-TEST.');
  if (operation === 'deploy') {
    let activation;
    try { activation = JSON.parse(readFileSync(new URL('./activation.json', import.meta.url), 'utf8')); } catch { /* Missing or malformed activation stays disabled. */ }
    if (!automaticDeploymentEnabled(process.env.DEPLOY_ENABLED, repository, activation)) {
      return output(false, 'Automatic deployment is disabled. Activate this repository or set ALIYUN_DEPLOY_ENABLED=true only after bootstrap and verification.');
    }
  }
  const request = async path => {
    const response = await fetch('https://api.github.com/repos/' + repository + path, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Cannot verify GitHub check metadata: HTTP ' + response.status);
    return response.json();
  };
  const main = await request('/git/ref/heads/main');
  if (main.object?.sha !== sha) return output(false, 'This commit is no longer the main branch head.');
  const result = await request('/actions/runs?' + new URLSearchParams({ head_sha: sha, event: 'push', per_page: '100' }));
  const ready = selectSuccessfulRuns(result.workflow_runs || [], sha, repository);
  if (!ready && operation === 'bootstrap') throw new Error('Bootstrap requires all four checks to pass for this exact main commit.');
  return output(ready, ready ? 'All four required workflows passed for this exact main commit.' : 'Checks for this commit are pending or failed; no deployment will occur.');
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) await main();
