import sqlite3
conn = sqlite3.connect(r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_inspect.db')
c = conn.cursor()
print('=== character_collections ===')
for row in c.execute('SELECT * FROM character_collections'):
    print(row)
print('\n=== characters ===')
for row in c.execute('SELECT id, project_id, collection_id, name, source_type, estimated_tokens FROM characters'):
    print(row)
print('\n=== project_resources (character) ===')
for row in c.execute("SELECT * FROM project_resources WHERE resource_type = 'character' ORDER BY project_id, resource_id"):
    print(row)
print('\n=== projects ===')
for row in c.execute('SELECT id, name FROM projects'):
    print(row)
conn.close()
