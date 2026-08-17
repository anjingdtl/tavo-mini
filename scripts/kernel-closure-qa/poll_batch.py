"""Poll the active multi-chapter batch on emulator until terminal state."""
import subprocess, sys, time, sqlite3, json, os

SERIAL = 'emulator-5554'
PKG = 'com.shinewriter'
LOCAL_DB = sys.argv[1]
BATCH_ID = sys.argv[2] if len(sys.argv) > 2 else None
INTERVAL = int(sys.argv[3]) if len(sys.argv) > 3 else 45
MAX_WAIT = int(sys.argv[4]) if len(sys.argv) > 4 else 3600

ADB = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk', 'platform-tools', 'adb.exe')


def pull():
    with open(LOCAL_DB, 'wb') as f:
        subprocess.run([ADB, '-s', SERIAL, 'exec-out', 'run-as', PKG,
                        'cat', 'databases/shine_writer.db'], stdout=f, check=True)


def snapshot():
    db = sqlite3.connect(LOCAL_DB)
    db.row_factory = sqlite3.Row
    where = f"project_id IN (SELECT project_id FROM multi_chapter_batches WHERE id='{BATCH_ID}')" if BATCH_ID else '1=1'
    row = db.execute(f"SELECT id, status, current_ordinal, completed_count, used_llm_calls, error_code, error_message, pause_reason FROM multi_chapter_batches WHERE id='{BATCH_ID}'").fetchone() if BATCH_ID else None
    if row is None:
        return None
    return dict(row)


start = time.time()
last = None
while time.time() - start < MAX_WAIT:
    pull()
    s = snapshot()
    if s is None:
        print('batch not found'); sys.exit(2)
    if s != last:
        print(json.dumps(s, ensure_ascii=False), flush=True)
        last = s
    if s['status'] in ('completed', 'paused', 'failed', 'cancelled'):
        print('TERMINAL', s['status'])
        sys.exit(0)
    time.sleep(INTERVAL)
print('TIMEOUT')
sys.exit(1)
