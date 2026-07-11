import sqlite3
import sys
import json
from datetime import datetime

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
c = conn.cursor()

# Reset characters and project_resources for clean state
c.execute("DELETE FROM characters")
c.execute("DELETE FROM project_resources WHERE resource_type='character'")

now = datetime.now().isoformat()

# Use existing collection id=1 or create one
c.execute("SELECT id FROM character_collections ORDER BY id ASC LIMIT 1")
row = c.fetchone()
if row:
    collection_id = row[0]
else:
    c.execute("INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (0, ?, 1, 50000, 0, ?)", ('TestCollection', now))
    collection_id = c.lastrowid

# Simulate single character import via ensureDefaultCharacterCollection + createCharacter
data_json = json.dumps({"name":"ImportedChar","description":"Imported character","first_mes":"Hello"})
c.execute(
    "INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (0, ?, ?, 'json', ?, 50000, 10, ?)",
    (collection_id, 'ImportedChar', data_json, now)
)
char_id = c.lastrowid

# createCharacter links resource to project 1 when currentProject exists
c.execute(
    "INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (1, 'character', ?, 1)",
    (char_id,)
)

conn.commit()
print(f'collection_id={collection_id}, char_id={char_id}')
conn.close()
