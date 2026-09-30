import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { OpenCodeAdapter } from "./opencode-adapter.ts";
import type { AgentDescriptor, ManifestTask } from "../types.ts";
import { prepareTaskRequest } from "../request.ts";
import { makeNodeShim, tempDir } from "../test-support.ts";

interface Shim {
  bin: string;
  argsFile: string;
}

function makeShim(t: TestContext): Shim {
  const dir = tempDir(t, "forge-opencode-adapter-");
  const argsFile = join(dir, "args.json");
  const bin = makeNodeShim(dir, "fake-opencode", `
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
  );
  return { bin, argsFile };
}

function makeTask(): ManifestTask {
  return {
    id: "t1",
    title: "Build the scanner",
    description: "Implement the recursive scanner.",
    dependencies: [],
    expectedOutputs: ["src/discovery/scanner.ts"],
    validationCommands: ["npm run typecheck"],
    approvalRequired: false,
    sourceLines: [],
  };
}

function makeAgent(path: string): AgentDescriptor {
  return {
    name: "discovery-engineer",
    description: "Discovery engineer",
    path,
    expertise: [],
    collaboration: [],
    constraints: [],
    rawBody: "You are a Discovery Engineer.\n- scan repos read-only",
  };
}

async function invokeWith(shim: Shim, agent: AgentDescriptor, root: string): Promise<void> {
  const original = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = shim.bin;
  try {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.invoke(prepareTaskRequest({ agent, task: makeTask(), repoRoot: root, defaultModel: adapter.defaultModel }));
    assert.equal(result.success, true);
  } finally {
    if (original === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = original;
  }
}

function recordedExecution(shim: Shim, root: string): string {
  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  const prompt = recorded.at(-1)!;
  const file = prompt.match(/execution file "([^"]+)"/)?.[1];
  assert.ok(file, prompt);
  assert.ok(prompt.length < 1000, prompt);
  return readFileSync(join(root, file), "utf8");
}

test("passes --agent for .opencode-rooted agents and omits the inline persona", async (t) => {
  const root = tempDir(t, "forge-opencode-repo-");
  const agent = makeAgent(join(root, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  assert.ok(recorded.includes("--agent"));
  assert.ok(recorded.includes(agent.name));
  assert.ok(!recorded.some((arg) => arg.includes("You are a Discovery Engineer")));
});

test("preserves the provider prefix for OpenCode model IDs", async (t) => {
  const root = tempDir(t, "forge-opencode-model-repo-");
  const agent = { ...makeAgent(join(root, ".opencode", "agents", "discovery-engineer.md")), model: "github-copilot/gpt-5.6-luna" };
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  const modelIndex = recorded.indexOf("--model");
  assert.ok(modelIndex >= 0);
  assert.equal(recorded[modelIndex + 1], "github-copilot/gpt-5.6-luna");
});

test("falls back to inlining the persona for non-.opencode harness roots", async (t) => {
  const root = tempDir(t, "forge-agents-repo-");
  const agent = makeAgent(join(root, ".agents", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  assert.ok(!recorded.includes("--agent"));
  assert.ok(recordedExecution(shim, root).includes("You are a Discovery Engineer"));
});

test("never passes --agent when the agent has no name", async (t) => {
  const root = tempDir(t, "forge-noname-repo-");
  const agent = { ...makeAgent(join(root, ".opencode", "agents", "unnamed.md")), name: "" };
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  assert.ok(!recorded.includes("--agent"));
  assert.ok(recordedExecution(shim, root).includes("You are a Discovery Engineer"));
});

test("prompt includes the execute-now directive so agents do not just acknowledge", async (t) => {
  const root = tempDir(t, "forge-directive-repo-");
  const agent = makeAgent(join(root, ".agents", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  const prompt = recordedExecution(shim, root);
  assert.ok(prompt.includes("Perform the task now"), prompt);
  assert.ok(prompt.includes("list the files you created or changed"), prompt);
});

test("prompt surfaces the per-task timeout and retry budget when provided", async (t) => {
  const root = tempDir(t, "forge-budget-repo-");
  const agent = makeAgent(join(root, ".agents", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);
  const original = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = shim.bin;
  try {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.invoke(prepareTaskRequest({ agent, task: makeTask(), repoRoot: root, timeoutMs: 60_000, maxRetries: 2 }));
    assert.equal(result.success, true);
  } finally {
    if (original === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = original;
  }

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  const prompt = recordedExecution(shim, root);
  assert.ok(prompt.includes("Per-task timeout: 60s"), prompt);
  assert.ok(prompt.includes("retried up to 2 time(s)"), prompt);
});

test("prompt includes the normalized default budget when no overrides are provided", async (t) => {
  const root = tempDir(t, "forge-nobudget-repo-");
  const agent = makeAgent(join(root, ".agents", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);

  await invokeWith(shim, agent, root);

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  const prompt = recordedExecution(shim, root);
  assert.ok(prompt.includes("Per-task timeout: 600s"), prompt);
  assert.ok(prompt.includes("retried up to 0 time(s)"), prompt);
});

test("FORGE_ENGINE_NATIVE_AGENT=0 forces the inline-persona fallback for .opencode agents", async (t) => {
  const root = tempDir(t, "forge-nonative-repo-");
  const agent = makeAgent(join(root, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeShim(t);
  const original = process.env.FORGE_ENGINE_NATIVE_AGENT;
  process.env.FORGE_ENGINE_NATIVE_AGENT = "0";
  try {
    await invokeWith(shim, agent, root);
  } finally {
    if (original === undefined) delete process.env.FORGE_ENGINE_NATIVE_AGENT;
    else process.env.FORGE_ENGINE_NATIVE_AGENT = original;
  }

  const recorded = JSON.parse(readFileSync(shim.argsFile, "utf8")) as string[];
  assert.ok(!recorded.includes("--agent"));
  assert.ok(recordedExecution(shim, root).includes("You are a Discovery Engineer"));
});

// ─── OpenCode v2 project resolution (ADR-058) ─────────────────────────────────
//
// v2 removed `run --dir` and `run --attach`, and `run` takes no path argument:
// a trailing path is swallowed into the prompt. The project is selected from the
// inherited `PWD`, which the adapter therefore corrects to the task root the
// spawn `cwd` already sets. These tests pin both halves of that contract, since
// a regression here silently runs a task against the wrong project.

/** Shim that records argv, cwd, and PWD, so project selection is observable. */
function makeCwdShim(t: TestContext): { bin: string; recordFile: string } {
  const dir = tempDir(t, "forge-opencode-cwd-");
  const recordFile = join(dir, "record.json");
  const bin = makeNodeShim(dir, "fake-opencode", `
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pwd: process.env.PWD ?? null,
}));
process.exit(0);
`,
  );
  return { bin, recordFile };
}

function recordedInvocation(recordFile: string): { argv: string[]; cwd: string; pwd: string | null } {
  return JSON.parse(readFileSync(recordFile, "utf8")) as { argv: string[]; cwd: string; pwd: string | null };
}

/** Invokes the adapter against `repoRoot` with the recording shim installed. */
async function invokeRecording(
  shim: { bin: string }, agent: AgentDescriptor, repoRoot: string,
): Promise<void> {
  const original = process.env.OPENCODE_BIN;
  process.env.OPENCODE_BIN = shim.bin;
  try {
    const adapter = new OpenCodeAdapter();
    const result = await adapter.invoke(prepareTaskRequest({ agent, task: makeTask(), repoRoot }));
    assert.equal(result.success, true, result.errorMessage);
  } finally {
    if (original === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = original;
  }
}

test("argv carries no --dir or --attach, both removed in OpenCode v2", async (t) => {
  const root = tempDir(t, "forge-opencode-argv-repo-");
  const agent = makeAgent(join(root, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeCwdShim(t);

  await invokeRecording(shim, agent, root);

  const { argv } = recordedInvocation(shim.recordFile);
  assert.ok(!argv.includes("--dir"), `argv still passes --dir: ${argv.join(" ")}`);
  assert.ok(!argv.includes("--attach"), `argv still passes --attach: ${argv.join(" ")}`);
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--auto"), "per-task permissions stay auto-approved");
});

test("the project is pinned by the spawn cwd, with PWD corrected to match", async (t) => {
  const root = tempDir(t, "forge-opencode-cwd-repo-");
  const agent = makeAgent(join(root, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeCwdShim(t);

  await invokeRecording(shim, agent, root);

  const { cwd, pwd, argv } = recordedInvocation(shim.recordFile);
  // `cwd` fixes the filesystem the task works in.
  assert.equal(cwd, resolve(root));
  // v2 selects the project from the inherited `PWD`, so it has to agree with
  // `cwd`. This process is normally `npm run workflow-engine` from the engine's
  // own package dir; an uncorrected `PWD` sends the task there instead, which
  // is invisible in a sequential run and strands every sandboxed task.
  assert.equal(pwd, resolve(root), "PWD must be corrected to the task root, not inherited from the engine");
  // The path must still not appear in argv (v2 reads it as prompt text).
  assert.ok(!argv.includes(resolve(root)), `argv leaks the repo path: ${argv.join(" ")}`);
});

test("a sandbox worktree is selected by cwd, keeping parallel tasks isolated", async (t) => {
  const parent = tempDir(t, "forge-opencode-sandbox-");
  const worktree = join(parent, "worktrees", "t1");
  // The adapter mirrors the execution file into the task root, so the worktree
  // must exist before the spawn - a real sandbox is created by `sandbox.ts`.
  mkdirSync(worktree, { recursive: true });
  const agent = makeAgent(join(worktree, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeCwdShim(t);

  await invokeRecording(shim, agent, worktree);

  const { cwd, argv } = recordedInvocation(shim.recordFile);
  assert.equal(cwd, resolve(worktree), "each task must run in its own worktree");
  assert.ok(!argv.includes(resolve(worktree)), `argv leaks the worktree path: ${argv.join(" ")}`);
});

// The regression this pins is the one that stranded a whole task: the engine is
// launched as `npm run workflow-engine` from its own package directory, so the
// child inherits a `PWD` pointing there. A sandboxed task then runs against the
// engine instead of its worktree, cannot find the execution file the adapter
// wrote into that worktree, and reports the task's expected outputs missing
// without having written any of them.
test("a PWD inherited from the engine's own package dir is corrected, not passed through", async (t) => {
  const engineDir = tempDir(t, "forge-opencode-engine-pkg-");
  const worktree = join(tempDir(t, "forge-opencode-sandbox-"), "worktrees", "t1");
  mkdirSync(worktree, { recursive: true });
  const agent = makeAgent(join(worktree, ".opencode", "agents", "discovery-engineer.md"));
  const shim = makeCwdShim(t);

  const originalPwd = process.env.PWD;
  const originalBin = process.env.OPENCODE_BIN;
  process.env.PWD = engineDir;
  process.env.OPENCODE_BIN = shim.bin;
  try {
    const result = await new OpenCodeAdapter().invoke(prepareTaskRequest({ agent, task: makeTask(), repoRoot: worktree }));
    assert.equal(result.success, true, result.errorMessage);
  } finally {
    if (originalPwd === undefined) delete process.env.PWD;
    else process.env.PWD = originalPwd;
    if (originalBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = originalBin;
  }

  const { cwd, pwd } = recordedInvocation(shim.recordFile);
  assert.equal(cwd, resolve(worktree), "the task must still run in its own worktree");
  assert.equal(pwd, resolve(worktree), `PWD leaked the engine's package dir: ${pwd}`);
  assert.notEqual(pwd, engineDir, "PWD must never point at the engine's own package dir");
});
