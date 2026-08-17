"""Seed a fresh outline project with N chapters for kernel-closure QA rounds."""
import sqlite3, sys, subprocess, datetime, json

DB_LOCAL = 'docs/optimization/evidence/kernel-closure-20260816/qa_work.db'

def pull():
    subprocess.run(['adb','-s','emulator-5554','exec-out','run-as','com.shinewriter',
                    'cat','databases/shine_writer.db'], stdout=open(DB_LOCAL,'wb'), check=True)

def push():
    subprocess.run(['adb','-s','emulator-5554','push',DB_LOCAL,'/data/local/tmp/seed.db'], check=True, capture_output=True)
    subprocess.run(['adb','-s','emulator-5554','shell',
                    'run-as com.shinewriter cp /data/local/tmp/seed.db databases/shine_writer.db'], check=True)
    # Drop the hot journal so the next open cannot roll the seed back.
    subprocess.run(['adb','-s','emulator-5554','shell',
                    'run-as com.shinewriter rm -f databases/shine_writer.db-journal'], check=True)
    subprocess.run(['adb','-s','emulator-5554','shell','rm /data/local/tmp/seed.db'], check=True)

def main(project_name, n_chapters, premise):
    subprocess.run(['adb','-s','emulator-5554','shell','am force-stop com.shinewriter'], check=True)
    import time; time.sleep(1.5)
    pull()
    db = sqlite3.connect(DB_LOCAL)
    cur = db.cursor()
    now = datetime.datetime.now().isoformat()
    cur.execute("INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, 'outline', ?, ?)",
                (project_name, now, now))
    pid = cur.execute("SELECT MAX(id) FROM projects").fetchone()[0]
    ids = []
    for i in range(n_chapters):
        cur.execute(
            "INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, '', 'planned', ?, ?)",
            (pid, i, f'第{i+1}章', premise.replace('{n}', str(i+1)), now, now))
        ids.append(cur.execute("SELECT MAX(id) FROM chapters").fetchone()[0])
    db.commit(); db.close()
    push()
    print(json.dumps({'projectId': pid, 'chapterIds': ids}))

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]), sys.argv[3])
