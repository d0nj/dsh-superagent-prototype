/** Stand-in account CLIs for tests: a program the OS starts, whatever the platform, so its arguments arrive unparsed. */
import { chmodSync, copyFileSync, existsSync, writeFileSync } from 'node:fs'

/** The script each copied executable runs, by the executable's path. */
const scripts = new Map<string, string>()

/** The script a Windows stand-in needs as its first argument, or nothing where the file runs itself. */
export const programScript = (executable: string): string | undefined => scripts.get(executable)

/**
 * Writes `source`, a Node program, to `file` and returns the path to start it by. Only POSIX runs a script through its
 * `#!` line, so a Windows stand-in is a copy of the Node executable, which reads `file` as its first script argument.
 */
export function cli(file: string, source: string): string {
  writeFileSync(file, source + '\n')
  if (process.platform !== 'win32') {
    chmodSync(file, 0o755)
    return file
  }
  const copy = `${file}.exe`
  if (!existsSync(copy)) {
    if (!existsSync(process.execPath)) throw new Error(`The Node executable the tests run under is gone: ${process.execPath}`)
    copyFileSync(process.execPath, copy)
  }
  scripts.set(copy, file)
  return copy
}

/** A Node program that answers the command lines in `map`, as the CLI it stands in for would. */
export const answers = (map: Record<string, string>): string => [
  'const args = process.argv.slice(2).join(" ")',
  `const answers = ${JSON.stringify(map)}`,
  'process.stdout.write((answers[args] ?? "") + "\\n")',
  'process.exit(args in answers ? 0 : 1)',
].join('\n')

/**
 * A Node program that answers every command line in `map`, and answers the command line that merely starts with one of its
 * keys with that key's answer, for a CLI the test calls with a repository name it only partly knows.
 */
export const answersStartingWith = (map: Record<string, string>): string => [
  'const args = process.argv.slice(2).join(" ")',
  `const answers = ${JSON.stringify(map)}`,
  'const match = Object.keys(answers).find(key => args.startsWith(key))',
  'process.stdout.write((match ? answers[match] : "") + "\\n")',
  'process.exit(match ? 0 : 1)',
].join('\n')
