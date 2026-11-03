/** Tests for scripts/dsh-superagent, run against a temporary checkout under a path with spaces. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Starting a Python supervisor is slower than the default 5s on Windows, especially while other spec files run.
vi.setConfig({ testTimeout: 30_000 })
let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
/**
 * The supervisor runs under `python3` from the path, as an operator runs it. A suite that keeps a Python with psutil
 * elsewhere, such as a virtual environment, names it in `DSH_SUPERAGENT_PYTHON`; these tests then start that interpreter
 * directly, since only a program, not a batch file, reports the output a stop or a status check prints.
 */
const python = process.env.DSH_SUPERAGENT_PYTHON ?? 'python3'
const supervisor = (): string => join(root, 'scripts', 'dsh-superagent.py')
/** A child that lives until the test ends: a Node process waiting, or one that ignores a stop request when `hung` is set. */
function sleeper(hung = false): number {
  const body = hung
    ? 'require("process").on("SIGBREAK", () => {}); setInterval(() => {}, 1000)'
    : 'setInterval(() => {}, 1000)'
  const child = spawn(process.execPath, ['-e', body], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** Write the process list the supervisor reads, one `pid command line` per line, after the entries a test gave it. */
const processes = (...lines: string[]) => writeFileSync(join(root, 'processes.txt'), lines.map(line => `${line}\n`).join(''))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent.py'), supervisor())
  processes()
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
/** Runs the supervisor the way an operator does, reading the process list this test wrote. */
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile(python, [supervisor(), ...args],
    { env: { ...process.env, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '', DSH_SUPERAGENT_PROCESSES: join(root, 'processes.txt') },
      timeout: 60_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** A mock HTTP server that answers with `state`, from the start when `always` is set. */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), service(sleeper()))
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
})
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const served = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`, service(served))
  expect(await status('superagent')).toMatchObject({ pids: [served] })
})
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 60_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 60_000)
it('stops the service it started, and keeps its process id', async () => {
  const url = await answering(READY, true)
  const pid = sleeper()
  processes(service(pid))
  const started = await run('start', '--url', url, '--timeout', '10')
  expect(started).toMatchObject({ code: 0 })
  expect(await status('superagent')).toMatchObject({ pids: [pid] })
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(JSON.parse((await run('status')).stdout)).toMatchObject({ manually_stopped: true })
}, 60_000)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
}, 60_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  const pid = sleeper()
  processes(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 60_000)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
}, 60_000)

