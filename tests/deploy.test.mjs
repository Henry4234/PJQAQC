// The runner lives on the production host and this repository is public, so these checks fail the
// build if a change would let anything but the deploy workflow on main run there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoFile = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path) => readFileSync(repoFile(path), "utf8").replace(/\r/g, "");
const workflowFiles = readdirSync(repoFile(".github/workflows"));

// On Windows, plain "bash" may be WSL. Git Bash sets MSYSTEM and runs these the way Linux does.
const skip = process.platform === "win32" && !process.env.MSYSTEM ? "needs a POSIX shell" : false;

const bash = (script, args = [], env = {}) => {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    const existing = Object.keys(merged).find((k) => k.toLowerCase() === key.toLowerCase());
    merged[existing || key] = value;
  }
  return spawnSync("bash", [repoFile(script), ...args], { env: merged, encoding: "utf8" });
};

test("only the deploy workflow can reach the host's runner", () => {
  for (const file of workflowFiles) {
    const source = read(`.github/workflows/${file}`);
    assert.doesNotMatch(source, /self-hosted/, `${file} must not use the generic self-hosted label`);
    assert.equal(/pjqaqc-prod/.test(source), file === "deploy.yml", `${file} and the pjqaqc-prod runner`);
  }
});

test("the deploy workflow cannot be started by a pull request", () => {
  const source = read(".github/workflows/deploy.yml");
  const triggers = source.slice(source.indexOf("\non:"), source.indexOf("\npermissions:"));
  assert.doesNotMatch(triggers, /pull_request/);
  assert.match(source, /^permissions: \{\}$/m);
  assert.match(source, /workflow_run\.conclusion == 'success'/);
  assert.match(source, /workflow_run\.event == 'push'/, "a fork's branch named main must not qualify");
  assert.match(source, /workflow_run\.head_repository\.full_name == github\.repository/);
});

test("the job on the host runs no third-party code and receives no secrets", () => {
  const source = read(".github/workflows/deploy.yml");
  const job = source.slice(source.indexOf("\n  api:"), source.indexOf("\n  portal:"));
  assert.match(job, /runs-on: pjqaqc-prod/);
  assert.doesNotMatch(job, /uses:/);
  assert.doesNotMatch(job, /secrets\./);
});

test("the Worker waits for the API and is not deployed after a failed update", () => {
  const source = read(".github/workflows/deploy.yml");
  const job = source.slice(source.indexOf("\n  portal:"));
  assert.match(job, /needs: \[gate, api\]/);
  assert.match(job, /needs\.api\.result == 'success' \|\| needs\.api\.result == 'skipped'/);
  assert.doesNotMatch(job, /always\(\)/);
});

test("the runner checks every job against the guard installed outside the checkout", () => {
  const unit = read("deploy/pjqaqc-runner.service");
  const installer = read("deploy/install-runner.sh");
  assert.match(unit, /^Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=%h\/pjqaqc-deployment\/bin\/runner-job-guard\.sh$/m);
  assert.match(installer, /> "\$root\/bin\/runner-job-guard\.sh"/);
  assert.match(installer, /--no-default-labels/);
  assert.match(installer, /--labels pjqaqc-prod/);
  assert.match(installer, /sha256sum --check/);
  assert.doesNotMatch(unit, /secrets|EnvironmentFile/, "the runner must not be handed the API's secrets");
});

const REPOSITORY = "Henry4234/PJQAQC";
const ALLOWED = {
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main`,
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_run",
};

test("the guard accepts the deploy workflow on main", { skip }, () => {
  for (const GITHUB_EVENT_NAME of ["workflow_run", "workflow_dispatch"]) {
    const run = bash("deploy/runner-job-guard.sh", [], { ...ALLOWED, GITHUB_EVENT_NAME });
    assert.equal(run.status, 0, `${GITHUB_EVENT_NAME}: ${run.stdout}${run.stderr}`);
  }
});

test("the guard refuses everything else", { skip }, () => {
  const refused = {
    "a fork's pull request": {
      GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/9/merge",
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/evil.yml@refs/pull/9/merge`,
    },
    "a pull request reusing the deploy workflow's name": {
      GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/9/merge",
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/deploy.yml@refs/pull/9/merge`,
    },
    "pull_request_target": { GITHUB_EVENT_NAME: "pull_request_target" },
    "another workflow on main": { GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` },
    "the deploy workflow on a branch": {
      GITHUB_REF: "refs/heads/dev",
      GITHUB_WORKFLOW_REF: `${REPOSITORY}/.github/workflows/deploy.yml@refs/heads/dev`,
    },
    "a push to main": { GITHUB_EVENT_NAME: "push" },
    "another repository": {
      GITHUB_REPOSITORY: "someone/PJQAQC",
      GITHUB_WORKFLOW_REF: "someone/PJQAQC/.github/workflows/deploy.yml@refs/heads/main",
    },
    "missing variables": { GITHUB_REPOSITORY: "", GITHUB_WORKFLOW_REF: "", GITHUB_REF: "", GITHUB_EVENT_NAME: "" },
  };
  for (const [name, env] of Object.entries(refused)) {
    const run = bash("deploy/runner-job-guard.sh", [], { ...ALLOWED, ...env });
    assert.equal(run.status, 1, `${name} should be refused`);
    assert.match(run.stdout, /only accepts the deploy workflow/, name);
  }
});

// A real git history with stand-ins for the host's commands.
function host({ cloneArgs = null } = {}) {
  const dir = mkdtempSync(join(process.env.TEST_TMPDIR || tmpdir(), "pjqaqc-deploy-")).replaceAll("\\", "/");
  const home = `${dir}/home`;
  const root = `${home}/pjqaqc-deployment`;
  const code = `${root}/code`;
  const origin = `${dir}/origin.git`;
  const work = `${dir}/work`;
  const git = (cwd, ...args) => {
    const run = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", ...args],
      { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const commit = (path, content) => {
    mkdirSync(`${work}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(`${work}/${path}`, content);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", path);
    return git(work, "rev-parse", "HEAD");
  };

  mkdirSync(`${root}/bin`, { recursive: true });
  mkdirSync(`${root}/secrets`, { recursive: true });
  mkdirSync(work);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", origin);
  commit("deploy/pjqaqc-api.service", "[Service]\n");
  const first = commit("backend/app.py", "version = 1\n");
  git(work, "push", "-q", "origin", "main");
  if (cloneArgs) {
    // A checkout that only tracks another branch has no origin/main, as on the real host.
    git(work, "push", "-q", "origin", "main:refs/heads/deployed");
    const url = origin.startsWith("/") ? `file://${origin}` : `file:///${origin}`;
    git(dir, "clone", "-q", ...cloneArgs, "--branch", "deployed", url, code);
    const refs = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { cwd: code, encoding: "utf8" });
    assert.notEqual(refs.status, 0, "this checkout should start without origin/main");
  } else {
    git(dir, "clone", "-q", origin, code);
  }
  git(code, "checkout", "-q", "--detach", first);
  writeFileSync(`${root}/secrets/edge_secret`, "shared-secret\n");

  const stubs = `${dir}/stubs`;
  mkdirSync(stubs);
  const stub = (path, body) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub(`${stubs}/systemctl`, `echo "systemctl $*" >> "$HOME/calls"`);
  stub(`${stubs}/sleep`, "exit 0");
  stub(`${root}/bin/uv`, `echo "uv $*" >> "$HOME/calls"`);
  // Fails while the commit named in $HOME/bad is checked out, as a broken release would.
  stub(`${stubs}/curl`, `echo "curl $*" >> "$HOME/calls"
cat > "$HOME/curl-stdin"
[ "$(git -C "$HOME/pjqaqc-deployment/code" rev-parse HEAD)" != "$(cat "$HOME/bad" 2>/dev/null)" ]`);

  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
  return {
    first, commit, home,
    publish: () => git(work, "push", "-q", "origin", "main"),
    branch: () => {
      git(work, "checkout", "-q", "-b", "other");
      const sha = commit("backend/app.py", "not on main\n");
      git(work, "push", "-q", "origin", "other");
      git(code, "fetch", "-q", "origin", "other");
      return sha;
    },
    head: () => git(code, "rev-parse", "HEAD"),
    calls: () => (existsSync(`${home}/calls`) ? readFileSync(`${home}/calls`, "utf8") : ""),
    markBad: (sha) => writeFileSync(`${home}/bad`, `${sha}\n`),
    update: (sha) => bash("deploy/update.sh", [sha], {
      HOME: home, XDG_RUNTIME_DIR: `${dir}/run`, [pathKey]: `${stubs}${delimiter}${process.env[pathKey]}`,
    }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("update.sh installs a backend change and restarts the API", { skip }, () => {
  const h = host();
  try {
    const next = h.commit("backend/app.py", "version = 2\n");
    h.publish();
    const run = h.update(next);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(h.head(), next);
    assert.match(h.calls(), /uv sync --locked --no-dev/);
    assert.match(h.calls(), /systemctl --user restart pjqaqc-api/);
    assert.match(run.stdout, /healthy on/);
    assert.equal(readFileSync(`${h.home}/curl-stdin`, "utf8"), "X-PJQAQC-Edge: shared-secret\n");
    assert.doesNotMatch(h.calls(), /shared-secret/, "the secret must not be a command-line argument");
    assert.doesNotMatch(run.stdout, /pjqaqc-deployment|shared-secret/, "Actions logs are public");
  } finally { h.remove(); }
});

for (const [name, cloneArgs] of Object.entries({
  "tracks one other branch": ["--single-branch"],
  "is a shallow clone": ["--depth", "1"],
})) {
  test(`update.sh keeps working when the host's checkout ${name}`, { skip }, () => {
    const h = host({ cloneArgs });
    try {
      for (const version of [2, 3]) {  // the second round fails if origin/main goes stale
        const next = h.commit("backend/app.py", `version = ${version}\n`);
        h.publish();
        const run = h.update(next);
        assert.equal(run.status, 0, `version ${version}: ${run.stdout}${run.stderr}`);
        assert.equal(h.head(), next);
      }
    } finally { h.remove(); }
  });
}

test("the scripts and the guide never rely on the checkout's own fetch settings", () => {
  const explicit = /fetch(?: --quiet)? origin \+refs\/heads\/main:refs\/remotes\/origin\/main/;
  for (const file of ["deploy/update.sh", "deploy/install-runner.sh", "DEPLOYMENT.md"]) {
    assert.match(read(file), explicit, file);
    assert.doesNotMatch(read(file), /git( -C "\$\w+")? fetch( --quiet)? origin( main)?\s*$/m, `${file} has a plain fetch`);
  }
});

test("update.sh rolls back when the new version does not come up", { skip }, () => {
  const h = host();
  try {
    const next = h.commit("backend/app.py", "raise NameError\n");
    h.publish();
    h.markBad(next);
    const run = h.update(next);
    assert.equal(run.status, 1, "the workflow must see the failure");
    assert.equal(h.head(), h.first);
    assert.equal(h.calls().match(/restart pjqaqc-api/g).length, 2);
    assert.match(run.stdout, /Rolled back/);
  } finally { h.remove(); }
});

test("update.sh leaves the API running when the backend did not change", { skip }, () => {
  const h = host();
  try {
    const next = h.commit("README.md", "docs\n");
    h.publish();
    const run = h.update(next);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(h.head(), next);
    assert.doesNotMatch(h.calls(), /restart/);
  } finally { h.remove(); }
});

test("update.sh does not move the host backwards or off main", { skip }, () => {
  const h = host();
  try {
    const next = h.commit("backend/app.py", "version = 2\n");
    h.publish();
    assert.equal(h.update(next).status, 0);

    const older = h.update(h.first);
    assert.equal(older.status, 0, "re-running an old workflow is harmless");
    assert.equal(h.head(), next);

    const offMain = h.update(h.branch());
    assert.equal(offMain.status, 1);
    assert.match(offMain.stdout, /not on main/);
    assert.equal(h.head(), next);
  } finally { h.remove(); }
});
