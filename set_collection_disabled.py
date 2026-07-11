import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("UPDATE character_collections SET enabled=0 WHERE id=1")
c.execute("UPDATE project_resources SET enabled=0 WHERE resource_type='character'")
conn.commit()
conn.close()
