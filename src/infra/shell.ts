/** Windows shell primitives for dsh-superagent: command lines, executors for commands, and paths to the executables it starts. */
import { existsSync, realpathSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

export const WINDOWS = process.platform === 'win32'
/** The extensions `PATHEXT` gives a program started by name on Windows. */
const EXTENSIONS = ['.exe', '.cmd', '.bat', '.com']

/** Windows tools such as `gh` are `.exe` files; a batch file hands its arguments over only as one string. */
export function executableName(file: string): string {
  return resolveProgram(file)
}

/**
 * Returns `file` or, on Windows, that file with the extension a shell adds when it starts a program by name. Node starts
 * a `.bat` or `.cmd` through `cmd.exe`, which unpacks its arguments into one string, so a program started here is an
 * `.exe` or nothing: arguments reach an account CLI exactly as they were passed.
 */
function resolveProgram(file: string): string {
  if (!WINDOWS) return existsSync(file) ? realpathSync(file) : file
  if (extname(file)) return file
  const found = EXTENSIONS.find(candidate => existsSync(file + candidate))
  return found ? file + found : file
}

/** Returns whether a configured path is absolute, in the form the running platform uses. */
export function absolutePath(path: string): boolean {
  return isAbsolute(path)
}

/**
 * Returns the program and arguments that run a shell command. Deployment documentation writes these commands for
 * `sh -c`; Windows has no such shell, so it runs the same command through its own command interpreter.
 */
export function shellCommand(command: string): { program: string; args: string[] } {
  return WINDOWS ? { program: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { program: 'sh', args: ['-c', command] }
}

/** The text of a worker CLI shim, and what a shell finds it under. */
export interface Shim {
  /** The extension of the shim file, or `''` where a program can be a script without one. */
  extension: string
  /** The whole file: a header, the marker dsh-superagent owns it by, what it runs, and the lines that come before that. */
  text: (marker: string, dir: string, program: string) => string
  /** The text of a shim that fails with `message`, for a command this installation does not offer or forbids. */
  refusal: (marker: string, dir: string, message: string) => string
}

/** Runs `program` with the arguments the shim receives, after taking the shim directory out of PATH. */
function posixHead(dir: string): string {
  return [`self='${dir.replaceAll("'", "'\\''")}'`, 'rest=', 'IFS=:', 'set -f',
    'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
    'set +f', 'unset IFS', 'PATH=$rest', 'export PATH'].join('\n')
}

const posixProgram = (program: string): string => `'${program.replaceAll("'", "'\\''")}'`

function posixShimBuild(marker: string, dir: string, body: string): string {
  return `${'#'}!\/bin\/sh\n${marker}\n${posixHead(dir)}\n${body}\n`
}

const posixShim: Shim = {
  extension: '',
  text: (marker, dir, program) => posixShimBuild(marker, dir, `exec ${posixProgram(program)} "$@"`),
  refusal: (marker, dir, message) => posixShimBuild(marker, dir, `echo '${message.replaceAll("'", "'\\''")}' >&2\nexit 1`),
}

const windowsProgram = (program: string): string => `"${executableName(program)}" %*`

function windowsShimBuild(marker: string, dir: string, body: string): string {
  const head = ['setlocal EnableExtensions DisableDelayedExpansion', `set "self=${dir}"`, 'set "rest="',
    'for %%e in ("%PATH:;=" "%") do if /I not "%%~e"=="%self%" call set "rest=%%rest%%%%~e;"',
    // `endlocal` restores the caller's PATH, which the interpreter has already parsed the rest of the file with.
    'endlocal & set "PATH=%rest%"'].join('\r\n')
  return `@echo off\r\nREM ${marker.slice(2)}\r\n${head}\r\n${body}\r\n`
}

const windowsShim: Shim = {
  extension: '.cmd',
  text: (marker, dir, program) => windowsShimBuild(marker, dir, windowsProgram(program)),
  refusal: (marker, dir, message) => windowsShimBuild(marker, dir, `1>&2 echo ${message}\r\nexit /b 1`),
}

export const shim: Shim = WINDOWS ? windowsShim : posixShim
