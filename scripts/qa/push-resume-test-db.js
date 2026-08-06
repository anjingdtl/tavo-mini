// Push current test-logs/cur.db to device and set state for resume testing.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');

async function main() {
  const adb =
    process.env.SHINE_ADB ||
    `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
  const serial = 'emulator-5554';
  const pkg = 'com.shinewriter';
  const dbPath = 'test-logs/cur.db';

  // Set pt_msg1it5t_2 unresolved, pt_msg1hcso_1 resolved for resume testing.
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "UPDATE pipeline_tasks SET resolved_at = NULL, resolved_action = NULL WHERE id='pt_msg1it5t_2'",
  ).run();
  db.prepare(
    "UPDATE pipeline_tasks SET resolved_at = 1, resolved_action='reject' WHERE id='pt_msg1hcso_1'",
  ).run();
  db.close();
  console.log('set pt_msg1it5t_2 unresolved, pt_msg1hcso_1 resolved');

  // Push to device via stdin streaming (run-as cannot read /sdcard).
  spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', pkg]);
  const buf = fs.readFileSync(dbPath);
  const child = require('node:child_process').spawn(
    adb,
    [
      '-s', serial, 'shell',
      `run-as ${pkg} sh -c 'base64 -d > /data/user/0/${pkg}/databases/shine_writer.db'`,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  child.stdin.write(buf.toString('base64'));
  child.stdin.end();
  await new Promise(resolve => child.on('exit', resolve));

  // Verify.
  const verify = spawnSync(adb, [
    '-s', serial,
    'exec-out',
    `run-as ${pkg} cat databases/shine_writer.db`,
  ]);
  fs.writeFileSync(dbPath, verify.stdout);
  const vdb = new DatabaseSync(dbPath);
  for (const r of vdb
    .prepare(
      "SELECT id, status, resolved_at, resolved_action FROM pipeline_tasks WHERE target_type='chapter' AND target_id=1",
    )
    .all()) {
    console.log(r);
  }
  vdb.close();
  console.log('done');
}
main().catch(err => {
  console.error(err);
  process.exit(2);
});
