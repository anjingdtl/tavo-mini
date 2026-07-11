import sqlite3

conn = sqlite3.connect(r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_local4.db')
c = conn.cursor()

print('=== character_collections schema ===')
for row in c.execute('PRAGMA table_info(character_collections)'):
    print(row)

print('=== characters schema ===')
for row in c.execute('PRAGMA table_info(characters)'):
    print(row)

print('=== project_resources schema ===')
for row in c.execute('PRAGMA table_info(project_resources)'):
    print(row)

print('=== projects ===')
for row in c.execute('SELECT id, name FROM projects'):
    print(row)

print('=== current collections ===')
for row in c.execute('SELECT * FROM character_collections'):
    print(row)

print('=== current characters ===')
for row in c.execute('SELECT id, name, collection_id FROM characters'):
    print(row)

print('=== current project_resources (character) ===')
for row in c.execute("SELECT * FROM project_resources WHERE resource_type='character'"):
    print(row)

conn.close()
