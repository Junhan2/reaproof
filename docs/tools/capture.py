"""Runs a command in a real pseudo-terminal, answers each (y/N) question with the next answer,
and writes everything the terminal showed, escape codes included, to a file.

usage: python3 -I capture.py OUT_FILE COLUMNS ANSWERS -- COMMAND...
ANSWERS is a comma-separated list such as "y", or "" for none. A question past the last answer
gets Enter, which is its default: no. A command that shows nothing for a minute is stopped, and
the script then ends with 1.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios

out_path, columns, answers_arg = sys.argv[1], int(sys.argv[2]), sys.argv[3]
command = sys.argv[sys.argv.index('--') + 1:]
answers = [answer.encode() for answer in answers_arg.split(',') if answer]
QUIET_SECONDS = 60
# A question can arrive with the codes that move the cursor after it, so they are left out when looking.
CURSOR_CODES = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]')

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(sys.stdout.fileno(), termios.TIOCSWINSZ, struct.pack('HHHH', 60, columns, 0, 0))
    os.execvp(command[0], command)

shown = b''
answered = 0
was_stopped = False
while True:
    ready, _, _ = select.select([fd], [], [], QUIET_SECONDS)
    if not ready:
        # Nothing shown for that long: the command waits for something this script does not send.
        os.kill(pid, signal.SIGTERM)
        print(f'stopped: nothing shown for {QUIET_SECONDS} seconds', file=sys.stderr)
        was_stopped = True
        break
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    shown += data
    asked = shown.count(b'(y/N)')
    if asked > answered and CURSOR_CODES.sub(b'', shown).rstrip().endswith(b'(y/N)'):
        answered = asked
        os.write(fd, (answers.pop(0) if answers else b'') + b'\n')
_, status = os.waitpid(pid, 0)
with open(out_path, 'wb') as out:
    out.write(shown)
print('exit', os.waitstatus_to_exitcode(status), 'bytes', len(shown))
sys.exit(1 if was_stopped else 0)
