import base64
import subprocess
import sys

db_path = sys.argv[1]
with open(db_path, 'rb') as f:
    data = f.read()
b64 = base64.b64encode(data).decode('ascii')

adb = r'C:\Users\Administrator\AppData\Local\Android\Sdk\platform-tools\adb.exe'
# Clean any previous temp file
subprocess.run([adb, 'shell', 'run-as com.shinewriter rm -f /data/data/com.shinewriter/databases/shine_writer.db.b64'], check=False)
# Write base64 in chunks to avoid command line length limits
chunk_size = 4000
for i in range(0, len(b64), chunk_size):
    chunk = b64[i:i+chunk_size]
    marker = 'START' if i == 0 else 'APPEND'
    cmd = f"run-as com.shinewriter sh -c 'echo -n {chunk} >> /data/data/com.shinewriter/databases/shine_writer.db.b64'"
    subprocess.run([adb, 'shell', cmd], check=True)

# Decode base64 to final db
cmd = "run-as com.shinewriter sh -c 'base64 -d /data/data/com.shinewriter/databases/shine_writer.db.b64 > databases/shine_writer.db && rm /data/data/com.shinewriter/databases/shine_writer.db.b64'"
subprocess.run([adb, 'shell', cmd], check=True)
print('pushed')
