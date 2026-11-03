import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_ENV_PATTERN, type SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { GIT_LOCATION, agentVariables, credentialHelper, runAsWorker, verifyDirectory, withoutDirectory, workerBin, workerGitConfig, writeEnvironment, SHIM_EXTENSION }
  from '../src/infra/environment.ts'
import { WINDOWS, shellCommand } from '../src/infra/shell.ts'
import { CliError } from '../src/infra/commands.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

// Git and shell subprocesses can exceed the 5s default timeout when the test suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const program = (path: string, body: string): string => {
  // A worker shim's target is a program, and only on Windows does a shell need the extension that says so.
  if (WINDOWS) { const file = path + '.cmd'; writeFileSync(file, `@echo off\r\n${body}\r\n`); return file }
  writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path
}
/** The body of a stand-in that prints the arguments it receives, spelled for the platform's shell. */
const echo = (words: string): string => WINDOWS ? `echo ${words.replace('$*', '%*')}` : `echo "${words}"`
const pathSeparator = WINDOWS ? ';' : ':'
/** Worker shell environment after DSH strips credential-shaped variables. */
const workerEnv = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SENSITIVE_ENV_PATTERN.test(entry[0])))
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('worker shims', () => {
  it('run a wrapper that calls `gh` by name without reaching the shim again, and keep the caller\'s other PATH entries', async () => {
    const real = program(join(dir, 'real', 'gh'), echo('agent-bot'))
    const wrapper = WINDOWS
      ? program(join(dir, 'gh-agent'), `call "${real}" %*`)
      : program(join(dir, 'gh-agent'), `GH_CONFIG_DIR=${dir}/agent-config exec gh "$@"`)
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: wrapper }, feishu: undefined }), [])
    const bin = workerBin(dir)
    const other = WINDOWS ? [join(dir, 'venv'), join(dir, 'real')] : [join(dir, 'venv'), join(dir, 'real'), '/usr/bin', '/bin']
    const path = [bin, ...other].join(pathSeparator)
    // The shim is started by name, through the caller's PATH, as a worker's shell starts it.
    const { stdout } = await exec(join(bin, 'gh' + SHIM_EXTENSION), ['api', 'user'], { env: { ...process.env, PATH: path }, timeout: 10_000, shell: WINDOWS })
    expect(stdout.trim()).toContain('agent-bot')
    // The wrapper reaches the real `gh` by name through PATH: the shim directory is out of the copy it runs with, so it
    // would find the target rather than itself, and the caller's other entries are there.
    const shim = readFileSync(join(bin, 'gh' + SHIM_EXTENSION), 'utf8')
    expect(shim).toContain(dir)
    expect(shim).toContain(WINDOWS ? '"' : 'exec ')
  })
  it('make `lark-cli` fail without a Feishu bot and each blocked command fail with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    const run = (name: string, args: string[] = []) => exec(join(bin, name + SHIM_EXTENSION), args, { shell: WINDOWS })
    // `cmd.exe` ends the lines it writes, so the message is compared without them.
    const stderr = async (failure: unknown) => String((failure as { stderr?: string }).stderr ?? '').replaceAll('\r\n', '\n')
    await expect(run('lark-cli', ['im', '+chat-list']).catch(stderr)).resolves.toBe('lark-cli is unavailable: this installation has no Feishu bot.\n')
    await expect(run('personal-gh').catch(stderr)).resolves.toBe('personal-gh is blocked in this installation; use gh, which acts as agent-bot.\n')
    await expect(run('personal-gh')).rejects.toMatchObject({ code: 1 })
  })
  it('keep `gh` and `lark-cli` working, and shim no `git`, when the blocked commands name the commands workers need', async () => {
    const gh = program(join(dir, 'gh-agent'), echo('gh $*')), lark = program(join(dir, 'lark-bot'), echo('lark $*'))
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...base.github, cli: gh }, feishu: { ...base.feishu!, cli: lark } }), ['gh', 'git', 'lark-cli'])
    const bin = workerBin(dir)
    const outputs = [(await exec(join(bin, 'gh' + SHIM_EXTENSION), ['api', 'user'], { shell: WINDOWS })).stdout, (await exec(join(bin, 'lark-cli' + SHIM_EXTENSION), ['im'], { shell: WINDOWS })).stdout]
    expect(outputs.map(output => output.trim())).toEqual(['gh api user', 'lark im'])
    expect(readdirSync(bin)).not.toContain('git' + SHIM_EXTENSION)
  })
  it('replace only what dsh-superagent wrote and refuse anything else in its places', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh' + SHIM_EXTENSION, 'lark-cli' + SHIM_EXTENSION])
    // A file that merely contains the marker on a later line, a symlink to a shim, and a foreign gitconfig are all rejected.
    writeFileSync(join(workerBin(dir), 'notes'), `notes\nmore\n${readFileSync(join(workerBin(dir), 'gh' + SHIM_EXTENSION), 'utf8').split('\n')[1]}\n`)
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${join(workerBin(dir), 'notes')} was not written by dsh-superagent`)
    rmSync(join(workerBin(dir), 'notes'))
    // A symbolic link needs a privilege the Windows account running the tests may not hold, so it is not part of the contract there.
    if (!WINDOWS) {
      symlinkSync(join(workerBin(dir), 'gh'), join(workerBin(dir), 'link'))
      await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('link was not written by dsh-superagent')
      rmSync(join(workerBin(dir), 'link'))
    }
    writeFileSync(workerGitConfig(dir), '[user]\n\tname = someone\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow(`${workerGitConfig(dir)} was not written by dsh-superagent`)
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toBe('[user]\n\tname = someone\n')
  })
  it('replaces the files it wrote under the project\'s earlier names', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir }), ['old-cli', 'older-cli'])
    const legacy = (file: string, name: string) => writeFileSync(file, readFileSync(file, 'utf8').replace('Written by dsh-superagent', `Written by ${name}`))
    legacy(join(workerBin(dir), 'old-cli' + SHIM_EXTENSION), 'dsh-tag'); legacy(join(workerBin(dir), 'older-cli' + SHIM_EXTENSION), 'dsh-freelancer'); legacy(workerGitConfig(dir), 'dsh-go')
    await writeEnvironment(testDeployment({ stateDir: dir }), [])
    expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh' + SHIM_EXTENSION, 'lark-cli' + SHIM_EXTENSION])
    expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('Written by dsh-superagent')
  })
})

describe('agent git configuration', () => {
  it('ignores the operator\'s global and system git configuration, also after DSH drops credential-shaped variables', async () => {
    const home = join(dir, 'home'); mkdirSync(home)
    // Operator configuration that rewrites HTTPS to SSH, enables commit signing, and sets a credential helper.
    writeFileSync(join(home, '.gitconfig'), '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[commit]\n\tgpgsign = true\n[credential]\n\thelper = osxkeychain\n')
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: '/opt/agent tools/gh' } })
    await writeEnvironment(deployment, [])
    // Operator identity variables and git's fallback from the OS username must not apply to worker commits.
    const env = workerEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '12', GIT_AUTHOR_NAME: 'Operator', GIT_COMMITTER_EMAIL: 'operator@example.com', ...agentVariables(dir) })
    const git = async (...args: string[]): Promise<string> => (await exec('git', args, { cwd: dir, env })).stdout.trim()
    await git('init', '-q', 'repo')
    await exec('git', ['-C', 'repo', 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir, env })
    expect(await git('-C', 'repo', 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/acme/widgets.git')
    // The helper line the file holds is the one git reports, in the form the file's quoting gives it.
    const [origin = '', ...lines] = (await git('config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper')).split('\0')
    expect(origin).toBe(`file:${workerGitConfig(dir)}`)
    expect(lines.at(-2)).toBe(credentialHelper('/opt/agent tools/gh'))
    // No helper is configured outside the GitHub section, so none applies to another host.
    await expect(git('config', '--get-all', 'credential.helper')).rejects.toThrow()
    await expect(git('config', 'commit.gpgsign')).rejects.toThrow()
    await expect(git('config', 'core.abbrev')).rejects.toThrow()
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_EMAIL')
    await expect(git('-C', 'repo', 'commit', '--allow-empty', '-q', '-m', 'without identity')).rejects.toMatchObject({ stderr: expect.stringContaining('no email was given') })
    await git('-C', 'repo', '-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', 'commit', '--allow-empty', '-q', '-m', 'with identity')
    expect(await git('-C', 'repo', 'log', '-1', '--format=%an <%ae> / %cn <%ce>')).toBe('Alice <alice@example.com> / Alice <alice@example.com>')
  })
})

it('fails instead of asking the operator\'s askpass helpers when the agent\'s credential helper has no answer', async () => {
  const log = join(dir, 'asked')
  const askpass = program(join(dir, 'askpass'), `echo asked >> ${log}; echo operator-secret`)
  const agent = program(join(dir, 'real', 'gh'), 'exit 0')
  const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: agent } })
  await writeEnvironment(deployment, [])
  const env = workerEnv({ PATH: process.env.PATH, HOME: dir, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, ...agentVariables(dir) })
  await exec('git', ['init', '-q', 'repo'], { cwd: dir, env })
  await exec('git', ['-C', 'repo', 'config', 'core.askPass', askpass], { cwd: dir, env })
  const fill = exec('git', ['-C', 'repo', 'credential', 'fill'], { cwd: dir, env, timeout: 10_000 })
  fill.child.stdin?.end('protocol=https\nhost=github.com\n\n')
  await expect(fill).rejects.toMatchObject({ stderr: expect.stringContaining('terminal prompts disabled') })
  expect(() => readFileSync(log, 'utf8')).toThrow()
})

it('removes every spelling of a directory from PATH and keeps the other entries', () => {
  mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  symlinkSync(join(dir, 'state'), join(dir, 'link'))
  const bin = join(dir, 'state', 'worker-bin')
  const trailing = WINDOWS ? `${bin}\\` : `${bin}/`
  const kept = WINDOWS ? [join(dir, 'node_modules', '.bin')] : ['/usr/bin', 'node_modules/.bin']
  expect(withoutDirectory([trailing, join(dir, 'link', 'worker-bin'), ...kept].join(pathSeparator), bin))
    .toBe(kept.join(pathSeparator))
})

/** Minimal SubprocessRuntime backed by child_process.spawn with an isolated global git config. */
const subprocess = (config: string): SubprocessRuntime => ({
  spawn: ({ argv, cwd }: { argv: readonly string[]; cwd: string }) => {
    // Only a command interpreter runs a `.cmd` on Windows, and it takes the arguments as one command line.
    const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: WINDOWS && /\.(cmd|bat)$/i.test(argv[0]!), env: gitEnv({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }) })
    const output = { stdout: '', stderr: '' }
    child.stdout.on('data', chunk => { output.stdout += String(chunk) })
    child.stderr.on('data', chunk => { output.stderr += String(chunk) })
    const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
    const done = new Promise(resolve => child.on('close', code => resolve({ exitCode: code, signal: null })))
    return { done, collected: { stdout: reader('stdout'), stderr: reader('stderr') } }
  },
}) as unknown as SubprocessRuntime
describe('ticket directory check', () => {
  const signal = new AbortController().signal
  const env = () => gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' })
  const git = (...args: string[]) => exec('git', args, { cwd: dir, env: env() })
  const check = (directory: string) => verifyDirectory(join(dir, directory), subprocess(join(dir, 'global')), signal)
  beforeEach(() => { writeFileSync(join(dir, 'global'), '[credential]\n\thelper = global-helper\n') })
  it('passes a directory whose repository adds no credentials, and one outside any repository', async () => {
    await git('init', '-q', 'repo')
    await expect(check('repo')).resolves.toBeUndefined()
    // When no config key matches at all, git config --get-regexp exits with status 1.
    writeFileSync(join(dir, 'global'), '')
    await expect(check('real')).resolves.toBeUndefined()
  })
  it('names the credential settings of the repository\'s own configuration', async () => {
    await git('init', '-q', 'repo')
    await git('-C', 'repo', 'config', 'http.https://github.com/.extraheader', 'AUTHORIZATION: basic x')
    await expect(check('repo')).rejects.toThrow('sets http.https://github.com/.extraheader')
  })
  it('fails when git cannot read the repository\'s configuration, instead of passing it', async () => {
    await git('init', '-q', 'repo')
    writeFileSync(join(dir, 'repo', '.git', 'config'), '[core\n')
    await expect(check('repo')).rejects.toThrow(/bad config/)
  })
  it('reports a failed command\'s exit status', async () => {
    const command = shellCommand(WINDOWS ? 'echo nope 1>&2 & exit /b 3' : 'echo nope >&2; exit 3')
    const error = await runAsWorker(subprocess(join(dir, 'global')), [command.program, ...command.args], dir, signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect(error).toMatchObject({ message: 'nope', exitCode: 3 })
  })})

describe('the repository the host\'s environment names', () => {
  it('is left alone by the tests\' git and named in no worker\'s environment, as when they run inside `git rebase --exec`', async () => {
    // A scratch repository stands for the one under test, which `git rebase --exec` names in GIT_DIR and GIT_WORK_TREE.
    await exec('git', ['init', '-q', 'scratch'], { cwd: dir, env: gitEnv() })
    const config = () => readFileSync(join(dir, 'scratch', '.git', 'config'), 'utf8')
    const before = config()
    vi.stubEnv('GIT_DIR', join(dir, 'scratch', '.git')); vi.stubEnv('GIT_WORK_TREE', join(dir, 'scratch'))
    // The operator's limit on git's search for a repository names none, and stays.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', dir)
    try {
      // What the tests do: a repository of their own, checked as a ticket directory.
      await exec('git', ['init', '-q', 'repo'], { cwd: dir, env: gitEnv({ GIT_CONFIG_GLOBAL: join(dir, 'global'), GIT_CONFIG_NOSYSTEM: '1' }) })
      writeFileSync(join(dir, 'global'), '')
      await expect(verifyDirectory(join(dir, 'repo'), subprocess(join(dir, 'global')), new AbortController().signal)).resolves.toBeUndefined()
      expect(readdirSync(join(dir, 'repo'))).toContain('.git')
      expect(config()).toBe(before)
      // The worker environment, which workers' shells and the host's own commands get, names no repository.
      const env = workerEnv({ ...process.env, ...agentVariables(dir) })
      for (const name of GIT_LOCATION) expect(env, name).not.toHaveProperty(name)
      expect(env.GIT_CEILING_DIRECTORIES).toBe(dir)
    } finally { vi.unstubAllEnvs() }
  })
})
