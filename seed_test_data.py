import sqlite3
import base64
from datetime import datetime, timezone

DB_PATH = r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_inspect.db'
OUT_PATH = r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_inspect.db'

conn = sqlite3.connect(DB_PATH)
c = conn.cursor()
now = datetime.now(timezone.utc).isoformat()

# 清理旧测试数据
c.execute("DELETE FROM project_resources WHERE resource_type = 'character'")
c.execute("DELETE FROM characters")
c.execute("DELETE FROM character_collections")
c.execute("DELETE FROM projects WHERE id > 0")

# 创建测试项目
c.execute(
    "INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ('TestProject', 'outline', now, now)
)
project_id = c.lastrowid

# 创建人物卡合集
c.execute(
    "INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    (0, 'TestCollection', 1, 50000, 200, now)
)
collection_id = c.lastrowid

# 创建人物卡
data_json = '{"name":"LinChe","description":"Young archivist","first_mes":"Hello"}'
c.execute(
    "INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    (0, collection_id, 'LinChe', 'json', data_json, 50000, 100, now)
)
char1_id = c.lastrowid

data_json2 = '{"name":"XiaoYu","description":"Mysterious visitor","first_mes":"Hi there"}'
c.execute(
    "INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    (0, collection_id, 'XiaoYu', 'json', data_json2, 50000, 100, now)
)
char2_id = c.lastrowid

# 项目启用两个人物卡
c.execute(
    "INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)",
    (project_id, 'character', char1_id, 1)
)
c.execute(
    "INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)",
    (project_id, 'character', char2_id, 1)
)

conn.commit()

print(f'project_id={project_id}, collection_id={collection_id}, char1_id={char1_id}, char2_id={char2_id}')

# 验证
c.execute('SELECT * FROM character_collections')
print('character_collections:', c.fetchall())
c.execute('SELECT id, collection_id, name, enabled_for_project FROM (SELECT c.*, cc.enabled AS collection_enabled, COALESCE((SELECT enabled FROM project_resources pr WHERE pr.project_id = ? AND pr.resource_type = \'character\' AND pr.resource_id = c.id), 0) AS enabled_for_project FROM characters c LEFT JOIN character_collections cc ON cc.id = c.collection_id)', (project_id,))
print('characters:', c.fetchall())

conn.close()

# 同时输出 base64 到文件方便推送
with open(OUT_PATH, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('ascii')
with open(r'F:\ClaudeWorkSpace\projects\TAVO-MINI\shine_writer_inspect.db.b64', 'w') as f:
    f.write(b64)
print('base64 length:', len(b64))
