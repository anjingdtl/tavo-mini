import sqlite3
from datetime import datetime

conn = sqlite3.connect(r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_local4.db')
c = conn.cursor()

now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
project_id = 1

# 创建合集
c.execute(
    "INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    (project_id, '测试合集', 1, 50000, 200, now)
)
collection_id = c.lastrowid

# 创建人物卡
data_json = '{"name":"林澈","description":"年轻档案员","first_mes":"你好"}'
c.execute(
    "INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    (project_id, collection_id, '林澈', 'json', data_json, 50000, 100, now)
)
char1_id = c.lastrowid

data_json2 = '{"name":"苏晚","description":"神秘女子","first_mes":"你是谁"}'
c.execute(
    "INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    (project_id, collection_id, '苏晚', 'json', data_json2, 50000, 100, now)
)
char2_id = c.lastrowid

# 关联项目启用
c.execute(
    "INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)",
    (project_id, 'character', char1_id, 1)
)
c.execute(
    "INSERT INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)",
    (project_id, 'character', char2_id, 1)
)

conn.commit()

print(f'Created collection {collection_id}, characters {char1_id}, {char2_id}')

print('=== collections ===')
for row in c.execute('SELECT * FROM character_collections'):
    print(row)

print('=== characters ===')
for row in c.execute('SELECT id, name, collection_id FROM characters'):
    print(row)

print('=== project_resources ===')
for row in c.execute("SELECT * FROM project_resources WHERE resource_type='character'"):
    print(row)

conn.close()
