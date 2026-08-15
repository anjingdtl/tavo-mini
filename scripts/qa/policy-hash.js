const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(',')}}`;
}

function hashPolicy(policy) {
  return crypto.createHash('sha256').update(stableSerialize(policy), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    schemaVersion: 3,
    allocatorVersion: 'context-automation-v3',
    profile: 'balanced',
    waterLevels: { softRatio: 0.8, burstRatio: 0.95 },
    boards: {
      storyState: { softRatio: 0.2, elasticCeilingRatio: 0.3, priority: 8 },
      resources: { softRatio: 0.3, elasticCeilingRatio: 0.5, priority: 9 },
      slidingWindow: { softRatio: 0.25, elasticCeilingRatio: 0.4, priority: 8 },
      episodic: { softRatio: 0.15, elasticCeilingRatio: 0.3, priority: 6 },
    },
    globalReserveRatio: 0.1,
    resourceItems: {
      explicitSelectionBoost: 1.8,
      smallDemandFullFitBias: 4000,
      activationWeights: {
        primary_secondary_hit: 1.0,
        constant: 0.95,
        primary_hit: 0.9,
        recursive_hit: 0.75,
        project_fallback: 0.45,
        explicit: 1.0,
      },
    },
  };
}

if (require.main === module) {
  const dbPath = process.argv[2];
  if (dbPath) {
    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT value FROM settings WHERE key='context_auto_policy_v3'")
      .get();
    const live = row?.value ? JSON.parse(row.value) : null;
    console.log(
      JSON.stringify(
        {
          liveHash: live ? hashPolicy(live) : null,
          liveResourcesPriority: live?.boards?.resources?.priority,
          defaultHash: hashPolicy(defaultPolicy()),
          policyA: (() => {
            const p = defaultPolicy();
            p.boards.resources.priority = 11;
            return { hash: hashPolicy(p), resourcesPriority: 11 };
          })(),
          policyB: { hash: hashPolicy(defaultPolicy()), resourcesPriority: 9 },
        },
        null,
        2,
      ),
    );
    db.close();
  } else {
    const a = defaultPolicy();
    a.boards.resources.priority = 11;
    console.log(
      JSON.stringify(
        {
          policyA: { hash: hashPolicy(a), resourcesPriority: 11 },
          policyB: { hash: hashPolicy(defaultPolicy()), resourcesPriority: 9 },
        },
        null,
        2,
      ),
    );
  }
}

module.exports = { hashPolicy, defaultPolicy, stableSerialize };
