#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const port = Number(flag('--port', '8765'));
const host = flag('--host', '0.0.0.0');
const scenario = flag('--scenario', 'valid-small');
const delayMs = Number(flag('--delay-ms', scenario === 'slow-valid' ? '30000' : '0'));
const logPath = flag('--log', 'test-logs/mock-openai-server.jsonl');

fs.mkdirSync(logPath.split(/[\\/]/).slice(0, -1).join('/') || '.', {
  recursive: true,
});

let requestCount = 0;
const scenarioCounts = new Map();

const styleProfile = {
  schemaVersion: 2,
  summary: '以短句推进叙事，在信息揭示前保留可验证的悬念线索。',
  global: {
    narrative: {
      person: '使用第三人称限知；每段保持单一观察中心，切换时以场景转场标记。',
      focalization: '常态贴近当前角色感知；信息未知时不得越权揭示。',
      narrativeDistance: '动作近景与有限心理描写交替，每两至三段回到可观察行为。',
      tenseAndTimeHandling: '按事件顺序推进；回溯仅在触发后用一至两段交代并回到当前线。',
      perspectiveSwitchRules: ['场景切换才更换观察中心', '切换前先完成当前动作或对话回合'],
    },
    syntax: {
      sentenceLengthPattern: '常态使用12至24字句；紧张段落连续使用2至4个短句。',
      sentenceStructures: ['动作句先动词后结果', '解释句不超过两个分句'],
      punctuationHabits: ['对白用规范引号并减少感叹号', '停顿只在信息隐藏或犹疑处使用省略号'],
      paragraphPattern: '每段聚焦一个动作或一个感知变化；对白回合之间分段。',
    },
    diction: {
      register: '使用克制、具体的现代书面语；关键物件优先用可感知名词。',
      concreteness: '每段至少落地一个动作、声音或触感；抽象判断随后给出行为依据。',
      lexicalPreferences: ['优先短动词和具体方位词', '重复关键词在同场景保持一致'],
      expressionsToAvoid: ['空泛的“十分震撼”', '连续堆叠同义形容词'],
    },
    tone: {
      baseline: '基调冷静克制；冲突升级时只提高动作密度，不用口号替代事实。',
      emotionalAmplitude: '情绪分三步递进，每次变化由表情、动作或语气承载。',
      humorAndRestraint: '幽默只在安全间隙出现，冲突段落避免插入解释性玩笑。',
    },
    rhythm: {
      scenePacing: '行动场景短段快切，调查场景保留物件与线索的停顿。',
      expositionDensity: '每次说明不超过两段，说明后立即回到角色选择。',
      transitionMethods: ['用动作结果或环境变化完成转场', '跳时先给出明确的时间锚点'],
      chapterEndingPatterns: ['以未解决的选择收束', '末段留下可在下一章验证的具体线索'],
    },
    description: {
      sensoryPriorities: ['优先视觉与声音', '危险场景补充触感或温度'],
      environmentUsage: '环境描写必须影响角色判断或行动路径。',
      actionVsInteriorBalance: '动作与心理约一比一；心理段落后必须回到可见行为。',
      imageryHabits: ['比喻只绑定当前物件', '意象在同一章节最多复现两次并承担线索功能'],
    },
    dialogue: {
      dialogueDensity: '关键场景对白占三至六成；说明信息拆进多轮问答。',
      turnLength: '普通回合一至三句；争执时缩短为半句至一句。',
      attributionStyle: '动作或语气词优先于重复的“说道”。',
      subtextStyle: '重要信息先用回避或反问露出，再用行动验证。',
      expositionAvoidance: ['避免单人长篇讲解背景', '避免对白复述双方都已知的事实'],
    },
    informationReveal: {
      setupMethod: '先展示可观察细节，再在后续段落解释其意义。',
      foreshadowingMethod: '每个伏笔绑定一个具体物件、动作或时间点。',
      suspenseMethod: '保留一个关键因果缺口，用角色选择推动下一次揭示。',
    },
  },
  boundaryLocalDelta: {
    tone: '边界内样本保持克制语气，冲突时增加短句比例。',
    pacing: '近端章节行动推进略快，段落转折更密集。',
    sentenceAndParagraphShift: '短句和单动作段落增多，说明段落保持简短。',
    activeNarrativePatterns: ['先给物件线索再给解释', '以选择或未决问题收束场景'],
  },
  sceneVariants: [
    { sceneType: 'action', instructions: ['用短动词链推进', '每两至三句交代空间变化'], avoid: ['感叹句堆叠'], confidence: 0.8 },
    { sceneType: 'dialogue', instructions: ['一回合只推进一个信息点', '用动作承载潜台词'], avoid: ['角色互相复述已知背景'], confidence: 0.8 },
    { sceneType: 'emotion', instructions: ['先写身体反应再写判断', '情绪变化由选择体现'], avoid: ['直接命名全部情绪'], confidence: 0.8 },
    { sceneType: 'description', instructions: ['选择两种感官细节', '环境必须影响行动'], avoid: ['静态形容词连续堆叠'], confidence: 0.8 },
    { sceneType: 'transition', instructions: ['给出时间或空间锚点', '以动作结果完成切换'], avoid: ['无锚点的突然跳切'], confidence: 0.8 },
  ],
  characterVoices: [],
  globalAvoid: ['避免空泛评价', '避免越权揭示角色未知信息'],
  confidence: 0.8,
  coverage: { sourceChapterCount: 1, sampledChapterCount: 1, sampledKinds: ['opening', 'middle', 'ending'] },
};

const canonResult = {
  schemaVersion: 1,
  worldRules: [],
  characters: [],
  relationships: [],
  plotThreads: [],
  experiences: [],
  knowledge: [],
  states: [],
  timelineEvents: [],
};

function isStyleRequest(messages) {
  const text = messages.map(message => String(message?.content ?? '')).join('\n');
  return text.includes('风格分析器') || text.includes('style-v2') || text.includes('风格画像');
}

function responseContent(messages, requestNo) {
  const style = isStyleRequest(messages);
  if (scenario === 'empty') return '';
  if (scenario === 'malformed-json' && requestNo === 1) return '这不是合法 JSON';
  if (scenario === 'missing-fields' && requestNo === 1) return '{"schemaVersion":1,"characters":[]}';
  if (scenario === 'invalid-evidence') {
    return JSON.stringify({
      ...canonResult,
      worldRules: [{ name: 'mock-rule', statement: '不存在于章节中的引文', evidence: [{ quote: '不存在于章节中的引文' }] }],
    });
  }
  return JSON.stringify(style ? styleProfile : canonResult);
}

function writeLog(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { error: { message: 'invalid request JSON' } });
      return;
    }

    requestCount += 1;
    const requestNo = requestCount;
    const model = String(body.model ?? '');
    const count = (scenarioCounts.get(scenario) ?? 0) + 1;
    scenarioCounts.set(scenario, count);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    writeLog({
      requestNo,
      receivedAt: new Date().toISOString(),
      scenario,
      model,
      max_tokens: body.max_tokens,
      messageCount: messages.length,
      messages,
      authorization: '<redacted>',
    });

    const respond = () => {
      if (scenario === 'http-429-once' && requestNo === 1) {
        sendJson(res, 429, { error: { message: 'mock rate limit' } });
        return;
      }
      if (scenario === 'http-500-twice' && requestNo <= 2) {
        sendJson(res, 500, { error: { message: 'mock server error' } });
        return;
      }
      const content = responseContent(messages, requestNo);
      sendJson(res, 200, {
        id: `mock-${requestNo}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: Math.max(1, content.length), total_tokens: Math.max(2, content.length + 1) },
      });
    };

    if (scenario === 'timeout' || scenario === 'idle-timeout') return;
    if (delayMs > 0) {
      setTimeout(respond, delayMs);
    } else {
      respond();
    }
  });
});

server.listen(port, host, () => {
  console.log(`mock-openai-server listening on http://${host}:${port} scenario=${scenario}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
