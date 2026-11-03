#!/usr/bin/env python3
"""Manage a local dsh-superagent service (one DSH profile, default `superagent`).

`status`, `start`, and `restart` exit 0 while the service runs normally; 1 when it is stopped, duplicated, unreachable, or
reporting a runtime error, which `restart` may fix; 2 when it runs while a component such as a Source reports an error;
and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.

The service is a detached process writing to a log file rather than a tmux pane, so this runs where tmux does not,
notably Windows.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

try:
    import psutil
except ImportError:  # Reported once a running service would be inspected.
    psutil = None

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / '.artifacts'
CONTROL = ARTIFACTS / 'control'
KEEP_LOGS = 20
WINDOWS = os.name == 'nt'


def control(profile):
    """Return the control directory for `profile`, creating it if needed."""
    directory = CONTROL / 'profiles' / profile
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def stopped(profile):
    """Return whether `profile` was intentionally stopped."""
    return (control(profile) / 'manually-stopped').exists()


# A `conhost.exe` or `cmd.exe` first in the line is a console host or launcher naming the rest of its line, so it is no service.
NOT_A_SERVICE = {'conhost', 'conhost.exe', 'cmd', 'cmd.exe', 'sh', 'bash', 'powershell', 'pwsh'}
# A runner asks the program it runs to run, so the service itself is that program, one step down.
PASS_THROUGH = {'npm', 'npx', 'pnpm', 'pnpx', 'bun', 'bunx', 'yarn', 'node', 'cmd', 'cmd.exe', 'sh', 'bash', 'powershell', 'pwsh'}
# A wrapper names the program it runs after its own words, which are skipped to find it.
RUNNERS = NOT_A_SERVICE | PASS_THROUGH


def serves(args, profile):
    """Return whether a command line names the main DSH service for `profile`.

    Windows reports a command line with everything a POSIX `argv` keeps apart, program included, and a POSIX `argv` starts
    with its program, so the arguments are read with the program and without it.
    """
    return service_words(args, profile) is not None


def service_words(args, profile):
    """Return the arguments a service is named with, or None where they name no service for `profile`.

    A shell or console host names the program it runs after its own options, as `cmd.exe /c dsh.cmd` does, and that is the
    reading to inspect; the line itself names that host, which is no service.
    """
    if args and Path(args[0]).name.lower() in NOT_A_SERVICE:
        return None
    for reading in readings(args):
        if names_profile(reading, profile):
            return reading
    return None


def readings(args):
    """Yield `args` and every reading that starts after a wrapper program the line leads with, as `cmd.exe /c` or `node`."""
    yield args
    start = 0
    while start < len(args) and Path(args[start]).name.lower() in RUNNERS:
        start += 1
        yield args[start:]


def names_profile(args, profile):
    """Return whether the command line names `profile` and no other DSH command.

    `dsh <profile>` boots the profile named by the first word after the program, which `dsh --profile <profile>` also
    spells. On Windows the program is the only word before it; under `node` a script path comes first.
    """
    if not args or 'plugin' in args:
        return False
    for index, word in enumerate(args):
        if word == f'--profile={profile}' or (word == '--profile' and args[index + 1:index + 2] == [profile]):
            return True
    rest = args[1:]
    if rest and re.search(r'\.(?:c|m)?js$', rest[0], re.IGNORECASE):
        rest = rest[1:]
    return bool(rest) and rest[0] == profile


def processes(profile):
    """Return the PID of each running DSH service for `profile`, including instances started outside this script.

    A shell launcher and the service it starts are one service, reported as the interpreter, which holds the management
    API. Asking for that group's root to stop stops both.
    """
    if psutil is None:
        raise RuntimeError('psutil is required to find running dsh-superagent processes: run python -m pip install psutil')
    roots = []
    for pid, command in running_processes():
        # Matching the command line rather than the process name also finds packaged builds, whose name is neither `node` nor `dsh`.
        if command and serves(command, profile) and pid not in roots:
            roots.append(pid)
    found = []
    for root in roots:
        service_pid = root if gone(root) else service_of(root, profile)
        if service_pid not in found:
            found.append(service_pid)
    recorded = read_service_pid(profile)
    if recorded:
        # A packaged `dsh.exe` is recorded at launch and later hands over to the runtime it starts.
        service_pid = service_of(recorded, profile)
        if service_pid not in found:
            found.append(service_pid)
    return found


def gone(pid):
    """Return whether `pid` names no running process, as a scan of a live system never lists."""
    return psutil is not None and not psutil.pid_exists(pid)


def running_processes():
    """Yield `(pid, argv)` for every process this user can read, or for the list in `DSH_SUPERAGENT_PROCESSES`, which a test sets."""
    listing = os.environ.get('DSH_SUPERAGENT_PROCESSES')
    if listing:
        for line in Path(listing).read_text(encoding='utf-8').splitlines():
            if line.strip():
                pid, _, command = line.partition(' ')
                yield int(pid), command.split()
        return
    for process in psutil.process_iter(['pid', 'cmdline']):
        try:
            yield process.pid, process.info['cmdline'] or []
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue


def service_of(pid, profile):
    """Return the deepest process of `pid`'s tree that runs the service, or `pid` when the tree runs none.

    On Windows a packaged `dsh.exe` hands over to `node .../bin.js`, and Windows reports both command lines as serving
    the profile. The runtime is the deepest of them, and counting the launcher as a second instance would refuse a stop.
    """
    try:
        process = psutil.Process(pid)
        tree = process.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return pid
    pids = {child.pid for child in tree}
    service, depth = pid, 0
    for child in tree:
        try:
            if not serves(child.cmdline(), profile):
                continue
            below = sum(1 for parent in child.parents() if parent.pid in pids) + 1
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if below > depth:
            service, depth = child.pid, below
    return service


def running(pid):
    """Return whether `pid` is still running."""
    return psutil is not None and psutil.pid_exists(pid)


def state(url):
    """Fetch health and setup status from the management API, or return None if unreachable."""
    request = urllib.request.Request(url.rstrip('/') + '/orchestrator/api/state',
                                     headers={'x-orchestrator-request': '1'})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            value = json.load(response)
        # Keys omitted by another version read as empty so the service is not mistaken for unreachable.
        health, setup = value.get('health') or {}, value.get('setup') or {}
        entries = {name: entry if isinstance(entry, dict) else {} for name, entry in health.items()}
        return {'health': {name: entry.get('state') for name, entry in entries.items()},
                'errors': {name: str(entry.get('detail', '')) for name, entry in entries.items() if entry.get('state') == 'error'},
                'setup': setup.get('problem'), 'feishu': setup.get('feishuProblem')}
    except (OSError, ValueError, AttributeError):
        return None


PART_ERROR = 2
SETUP_WAITS = 3


def runtime_up(current):
    """Return whether the runtime is ready or paused awaiting operator action; a component still starting (such as history recovery) does not hold this up."""
    return current is not None and current['health'].get('runtime') in ('ready', 'paused')


def part_errors(current):
    """Return non-runtime components that are in an error state."""
    return {name: detail for name, detail in sorted(current['errors'].items()) if name != 'runtime'}


def outcome(pids, current):
    """Compute the CLI exit code from running PIDs and management API state."""
    if len(pids) != 1 or not runtime_up(current):
        return 1
    if current['setup']:
        return SETUP_WAITS
    # A component's lasting error, unlike a Feishu bot check that failed during setup, requires operator action.
    return PART_ERROR if part_errors(current) else 0


def status(args):
    pids = processes(args.profile)
    current = state(args.url) if pids else None
    print(json.dumps({'pids': pids, 'cwd': str(ROOT), 'url': args.url,
                      'manually_stopped': stopped(args.profile), 'health': current and current['health'],
                      'errors': current and current['errors'], 'setup': current and current['setup'],
                      'feishu': current and current['feishu']}, ensure_ascii=False, indent=2))
    return outcome(pids, current)


def interrupt(pid, group=None):
    """Ask a service this script started to shut down on its own terms.

    POSIX sends SIGINT. Windows can name only a process group, and its group id is the id of the process `start` created
    it for. Any other line may share the operator's console, where a console event would also reach the terminal and the
    DSH process running this script, so a service without a recorded group is not signalled at all.
    """
    if not WINDOWS:
        try:
            os.kill(pid, signal.SIGINT)
            return True
        except OSError:
            return False
    if group is None:
        return False
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.FreeConsole.restype = wintypes.BOOL
    kernel32.AttachConsole.argtypes = [wintypes.DWORD]
    kernel32.AttachConsole.restype = wintypes.BOOL
    kernel32.GenerateConsoleCtrlEvent.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.GenerateConsoleCtrlEvent.restype = wintypes.BOOL
    # Leave this process's console before attaching to the service's: AttachConsole fails while one owns a console.
    kernel32.FreeConsole()
    if not kernel32.AttachConsole(pid):
        return False
    try:
        return bool(kernel32.GenerateConsoleCtrlEvent(signal.CTRL_BREAK_EVENT, group))
    finally:
        kernel32.FreeConsole()


def terminate(pid):
    """Stop a service that did not answer its shutdown request, with the processes it started."""
    targets = [pid]
    try:
        targets += [child.pid for child in psutil.Process(pid).children(recursive=True)]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    for target in targets:
        try:
            os.kill(target, signal.SIGTERM)
        except OSError:
            continue
    gone = time.monotonic() + 5
    while running(pid):
        if time.monotonic() >= gone:
            raise RuntimeError(f'The service process {pid} did not exit; check status.')
        time.sleep(0.2)


def stop(args, intentional=True):
    """Stop the service gracefully, recording a manual stop marker when `intentional` is True."""
    pids = processes(args.profile)
    if len(pids) > 1:
        raise RuntimeError('Multiple dsh-superagent processes found; refusing to choose one.')
    # Write the stop marker before waiting so monitors respect the intentional stop even if graceful shutdown times out.
    if intentional:
        (control(args.profile) / 'manually-stopped').write_text(time.strftime('%Y-%m-%dT%H:%M:%S%z') + '\n')
    for pid in pids:
        interrupt(pid, read_group(args.profile))
    # A Windows runtime that handles neither gets its timeout to leave, then is ended with the processes it started: no
    # process group reaches a service whose console was created with CREATE_NO_WINDOW for it. POSIX only ever asks,
    # because a process still handling its last Executor step is the operator's work, not this script's to end.
    deadline = time.monotonic() + args.stop_timeout
    while any(running(pid) for pid in pids):
        if time.monotonic() >= deadline:
            if not WINDOWS:
                raise RuntimeError('Graceful stop timed out; the service is still running.')
            for pid in pids:
                terminate(pid)
            deadline = time.monotonic() + 5
            while any(running(pid) for pid in pids):
                if time.monotonic() >= deadline:
                    raise RuntimeError('The service did not stop; check status.')
                time.sleep(0.2)
            break
        time.sleep(0.5)
    clear_record(args.profile)
    print('dsh-superagent stopped. Automatic recovery is paused until start/restart.' if intentional else 'dsh-superagent stopped.')


def prune_logs(profile):
    """Retain only the newest `KEEP_LOGS` log files for `profile`."""
    name = re.compile(re.escape(f'dsh-superagent-{profile}-') + r'\d{8}-\d{6}-\d+\.log')
    logs = sorted((path for path in ARTIFACTS.iterdir() if name.fullmatch(path.name)), key=lambda path: path.stat().st_mtime)
    for path in logs[:-KEEP_LOGS]:
        path.unlink(missing_ok=True)


def read_service_pid(profile):
    """Return the recorded service pid while the process under it is still the one recorded, or None.

    PIDs are recycled, so a process running under a recorded pid is not necessarily the service it names.
    """
    try:
        pid = int((control(profile) / 'service.pid').read_text())
        started = float((control(profile) / 'service.start').read_text())
    except (OSError, ValueError):
        return None
    try:
        return pid if abs(psutil.Process(pid).create_time() - started) < 1 else None
    except (psutil.NoSuchProcess, psutil.AccessDenied, AttributeError, TypeError):
        return None


def record(profile, pid, group=None):
    """Record `pid` as the service, the console group `start` gave it, and the creation time that tells it apart from a
    process reusing the number."""
    try:
        started = psutil.Process(pid).create_time()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        clear_record(profile)
        return
    if group is None:
        group = read_group(profile)
    (control(profile) / 'service.start').write_text(repr(started) + '\n')
    (control(profile) / 'service.pid').write_text(f'{pid}\n')
    if group is not None:
        (control(profile) / 'service.group').write_text(f'{group}\n')


def read_group(profile):
    """Return the console group `start` gave the service, or None for a service started outside this script."""
    try:
        return int((control(profile) / 'service.group').read_text())
    except (OSError, ValueError):
        return None


def clear_record(profile):
    """Forget the recorded service pid."""
    (control(profile) / 'service.pid').unlink(missing_ok=True)
    (control(profile) / 'service.start').unlink(missing_ok=True)
    (control(profile) / 'service.group').unlink(missing_ok=True)


def launch(dsh, profile, log):
    """Start the service detached from this script so it outlives the terminal; return the PID of its root."""
    options = {'cwd': str(ROOT), 'stdin': subprocess.DEVNULL}
    if WINDOWS:
        # CTRL_BREAK_EVENT reaches only a process in a group of its own, and a console is where the runtime's handler
        # lives. CREATE_NO_WINDOW supplies both without the window CREATE_NEW_CONSOLE opens.
        with log.open('ab') as output:
            process = subprocess.Popen([dsh, '--profile', profile, '--no-open'],
                                       stdout=output, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW,
                                       **options)
    else:
        # start_new_session leaves the caller's process group, so `stop` reaches the runtime without touching the caller.
        with log.open('ab') as output:
            process = subprocess.Popen([dsh, '--profile', profile, '--no-open'],
                                       stdout=output, stderr=subprocess.STDOUT, start_new_session=True, **options)
    # A shell launcher takes a moment to run the interpreter that is the service.
    for _ in range(20):
        pid = service_of(process.pid, profile)
        if pid != process.pid:
            break
        time.sleep(0.1)
    record(profile, pid, process.pid)
    return pid


def start(args):
    pids = processes(args.profile)
    if len(pids) > 1:
        raise RuntimeError('Multiple dsh-superagent processes found; refusing to start another.')
    if not pids:
        dsh = shutil.which('dsh')
        if not dsh:
            raise RuntimeError('dsh must be on PATH.')
        if state(args.url) is not None:
            raise RuntimeError('An existing orchestrator answers at this URL; refusing duplicate startup.')
        stamp = time.strftime('%Y%m%d-%H%M%S')
        log = ARTIFACTS / f'dsh-superagent-{args.profile}-{stamp}-{os.getpid()}.log'
        log.touch()
        prune_logs(args.profile)
        record(args.profile, launch(dsh, args.profile, log))
        print('Log: ' + str(log), flush=True)
    else:
        record(args.profile, pids[0])
        print(f'dsh-superagent already running (PID {pids[0]}); no duplicate started.', flush=True)
    (control(args.profile) / 'manually-stopped').unlink(missing_ok=True)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        current = state(args.url)
        if processes(args.profile) and runtime_up(current):
            code = status(args)
            if current['setup']:
                print('dsh-superagent is waiting for setup: ' + str(current['setup'].get('detail', '')))
                print('Open the URL DSH printed in the log, then the dsh-superagent overview.')
            if current['feishu']:
                print('dsh-superagent runs without Feishu: ' + str(current['feishu'].get('detail', '')))
                print('Fix it on the Feishu card of the Source settings.')
            for name, detail in part_errors(current).items():
                print(f'{name} reports an error, which a restart does not fix: {detail}')
            return code
        time.sleep(1)
    status(args)
    raise RuntimeError('Startup health check timed out; inspect the log. Any running process was left intact.')


class OperationLock:
    """Exclusive lock on one control directory: flock on POSIX, byte lock on Windows, which has no flock."""

    def __init__(self, directory):
        self.path = directory / 'operation.lock'

    def __enter__(self):
        self.handle = self.path.open('a+')
        try:
            if WINDOWS:
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise RuntimeError('Another dsh-superagent control operation is in progress.') from None
        return self

    def __exit__(self, *exception):
        if WINDOWS:
            import msvcrt
            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'restart', 'status'])
    parser.add_argument('--profile', default=os.environ.get('DSH_SUPERAGENT_PROFILE') or 'superagent',
                        help='DSH profile that loads dsh-superagent.')
    parser.add_argument('--url', default=os.environ.get('DSH_SUPERAGENT_URL') or 'http://127.0.0.1:3082',
                        help='Health-check URL; override after changing the profile port.')
    parser.add_argument('--timeout', type=float, default=60, help='Startup timeout in seconds.')
    parser.add_argument('--stop-timeout', type=float, default=300,
                        help='Graceful shutdown timeout in seconds; running Executor Sessions finish their step first.')
    parser.add_argument('--respect-stop', action='store_true',
                        help='For monitoring: never start/restart after an intentional stop.')
    args = parser.parse_args()
    if args.timeout <= 0 or args.stop_timeout <= 0:
        parser.error('--timeout and --stop-timeout must be positive')
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*', args.profile):
        parser.error('--profile must be a DSH profile name')
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with OperationLock(control(args.profile)):
        if args.respect_stop and args.action in ('start', 'restart') and stopped(args.profile):
            print('Intentional stop is active; automatic recovery skipped.')
            return 0
        if args.action == 'status':
            return status(args)
        if args.action in ('stop', 'restart'):
            # Only a stop keeps automatic recovery off; a restart whose stop timed out leaves it on.
            stop(args, intentional=args.action == 'stop')
        if args.action in ('start', 'restart'):
            return start(args)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        if os.environ.get('DSH_SUPERAGENT_DEBUG'):
            raise
        print(str(error), file=sys.stderr)
        sys.exit(1)
