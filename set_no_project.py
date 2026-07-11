import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_project_id', '0')")
conn.commit()
for row in c.execute("SELECT key, value FROM settings WHERE key='current_project_id'"):
    print(row)
conn.close()
