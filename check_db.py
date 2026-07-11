import sqlite3

c = sqlite3.connect('shine_writer.db')
cur = c.cursor()

print('Tables:')
for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'"):
    print(' ', row[0])

print('\nlocal_models:')
for row in cur.execute('SELECT * FROM local_models'):
    print(row)

print('\nllm_config:')
for row in cur.execute('SELECT * FROM llm_config'):
    print(row)

print('\npipeline_tasks:')
for row in cur.execute('SELECT id, target_id, status, stage, created_at, updated_at, resolved_at FROM pipeline_tasks'):
    print(row)

print('\nchapters:')
for row in cur.execute('SELECT id, project_id, title, status, length(content) FROM chapters'):
    print(row)
