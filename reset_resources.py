import sqlite3
import sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("DELETE FROM project_resources WHERE resource_type='character'")
c.execute("UPDATE character_collections SET enabled=1 WHERE id=1")
conn.commit()
print('reset project_resources for characters')
conn.close()
