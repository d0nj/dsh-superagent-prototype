"""Which command lines the supervisor counts as its service, and which of them is the runtime.

`serves` answers "does this line belong to the service for the profile", which the supervisor asks of every process.
Set `DSH_SUPERAGENT_PYTHON` to a Python with psutil when the suite runs the whole supervisor; this test only imports its
rules, so it needs no interpreter of its own.
"""
import importlib.machinery
import importlib.util
from pathlib import Path
import types
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / 'scripts' / 'dsh-superagent.py'


def supervisor():
    """Load the supervisor as a module, which it is by name without one."""
    loader = importlib.machinery.SourceFileLoader('dsh_superagent_supervisor', str(SCRIPT))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(module)
    return module


class NoSuchProcess(Exception):
    pass


class AccessDenied(Exception):
    pass


class FakeProcess:
    """A process tree node for the supervisor's psutil calls."""

    def __init__(self, pid, cmdline, parent=None):
        self.pid = pid
        self._cmdline = cmdline
        self.parent = parent
        self.children_of = []

    def cmdline(self):
        return self._cmdline

    def parents(self):
        node = self.parent
        while node is not None:
            yield node
            node = node.parent

    def children(self, recursive=False):
        found, queue = [], list(self.children_of)
        while queue:
            current = queue.pop(0)
            found.append(current)
            queue.extend(current.children_of)
        return found


def tree(*lines):
    """Build the fake psutil module from `(pid, parent pid, argv)` lines."""
    nodes, roots = {}, {}
    for pid, parent, argv in lines:
        nodes[pid] = FakeProcess(pid, argv)
        roots[pid] = parent
    for pid, parent in roots.items():
        if parent in nodes:
            nodes[pid].parent = nodes[parent]
            nodes[parent].children_of.append(nodes[pid])
    return types.SimpleNamespace(Process=lambda pid: nodes[pid], NoSuchProcess=NoSuchProcess, AccessDenied=AccessDenied)


class ServesTest(unittest.TestCase):
    def setUp(self):
        self.supervisor = supervisor()

    def check(self, args, expected, label):
        self.assertEqual(self.supervisor.serves(args, 'superagent'), expected, label)

    def test_finds_the_service_however_the_program_is_named(self):
        self.check(['/opt/dsh', '--profile', 'superagent', '--no-open'], True, 'a packaged dsh')
        self.check(['/opt/dsh', '--profile=superagent'], True, 'the equals form')
        self.check(['node', '/opt/dsh.js', '--profile', 'superagent'], True, 'dsh under node')
        self.check(['/opt/my tools/dsh', '--profile', 'superagent'], True, 'a path with a space')
        self.check(['npx', 'dsh', '--profile', 'superagent'], True, 'npx starting dsh')

    def test_names_only_the_profile_it_asks_for(self):
        self.check(['/opt/dsh', '--profile', 'other'], False, 'another profile')
        self.check(['/opt/dsh', 'plugin', '--profile', 'superagent'], False, 'a plugin command')
        self.check(['/opt/dsh', 'status', '--profile', 'superagent'], True, 'a subcommand that runs the service')

    def test_reads_the_profile_that_follows_the_program(self):
        self.check(['dsh', 'superagent', '--no-open'], True, 'the profile as the first word')
        self.check(['node', '/opt/dsh/lib/bin.js', 'superagent'], True, 'the profile after the CLI script')
        self.check(['dsh', 'web'], False, 'another profile as the first word')

    def test_leaves_out_what_only_names_the_service(self):
        self.check(['conhost.exe', '0x4'], False, 'a console host')
        self.check(['cmd.exe', '/c', 'dsh.cmd', '--profile', 'superagent'], False, 'a launcher naming its line')
        self.check([], False, 'nothing')

    def test_takes_the_deepest_process_of_a_launcher_as_the_runtime(self):
        self.supervisor.psutil = tree((1, 0, ['C:/bin/dsh.exe', '--profile', 'superagent']),
                                      (2, 1, ['node', 'C:/dsh/lib/bin.js', '--profile', 'superagent']))
        self.assertEqual(self.supervisor.service_of(1, 'superagent'), 2, 'a packaged dsh handing over to node')

    def test_takes_a_service_that_runs_itself(self):
        self.supervisor.psutil = tree((1, 0, ['node', 'C:/dsh/lib/bin.js', '--profile', 'superagent']))
        self.assertEqual(self.supervisor.service_of(1, 'superagent'), 1, 'node running the CLI in place')

    def test_takes_the_deepest_of_a_shell_launcher_too(self):
        self.supervisor.psutil = tree((1, 0, ['cmd.exe', '/c', 'dsh.cmd', '--profile', 'superagent']),
                                      (2, 1, ['node', 'C:/dsh/lib/bin.js', '--profile', 'superagent']))
        self.assertEqual(self.supervisor.service_of(1, 'superagent'), 2, 'cmd.exe running the CLI')

    def test_leaves_a_tree_that_runs_no_service_as_it_is(self):
        self.supervisor.psutil = tree((1, 0, ['notepad.exe']))
        self.assertEqual(self.supervisor.service_of(1, 'superagent'), 1, 'a process that is no service')


if __name__ == '__main__':
    unittest.main()
