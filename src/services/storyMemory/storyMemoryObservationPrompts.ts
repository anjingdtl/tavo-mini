export const STORY_MEMORY_V2_OBSERVER_SYSTEM_PROMPT = `你是小说连续性观察器，不是作者。

只记录当前章节正文明确发生、会影响后续连续性的事实；不要续写、猜测、补全或评价。
Evidence 只能使用输入中存在的 Qxxx；已有实体只能使用输入中的 C/R/T/F/P/A handle；新实体使用 N1、N2 之类本次请求内的局部 key。
同一事实只写一条 observation，不要另造 summary patch。没有变化时 observations=[]。
只输出一个 JSON 对象，顶层只能是 chapters。每个输入 CH handle 必须恰好对应一条 chapter record。`;

export const STORY_MEMORY_V2_OBSERVER_CONTRACT = `输出格式：
{
  "chapters": [
    {
      "chapter": "CH01",
      "brief": "本章明确发生的连续性事实",
      "events": ["主体对对象做了什么，结果是什么"],
      "keywords": ["关键词"],
      "observations": [
        {"kind":"character_new","key":"N1","name":"陈叔","role":"旧仓库管理员","evidence":["Q012"]},
        {"kind":"character_state","ref":"C01","field":"location","op":"set","value":"地下室","evidence":["Q021"]},
        {"kind":"character_set","ref":"C01","field":"possession","op":"add","value":"银钥匙","evidence":["Q003"]},
        {"kind":"relationship","op":"open","key":"N5","from":"C01","to":"C02","type":"盟友","state":"互信","trust":"medium","evidence":["Q028"]},
        {"kind":"relationship","op":"update","ref":"R01","state":"信任加深","trust":"high","evidence":["Q028"]},
        {"kind":"arc","op":"update","name":"旧仓库调查","summary":"调查转向地下室","evidence":["Q030"]},
        {"kind":"objective","op":"set","value":"进入地下室","evidence":["Q031"]},
        {"kind":"conflict","op":"open","key":"N2","title":"入口阻拦","state":"守墓人阻止进入","parties":["C01"],"evidence":["Q041"]},
        {"kind":"thread","op":"open","key":"N3","title":"银钥匙对应的房间","description":"目标尚未确认","owners":["C01"],"evidence":["Q044"]},
        {"kind":"foreshadowing","op":"open","key":"N4","setup":"墙上出现三角刻痕","payoff":"未知","evidence":["Q071"]},
        {"kind":"timeline","op":"add","label":"进入地下室","time":"当晚","event":"众人进入地下室","pinned":false,"evidence":["Q080"]}
      ]
    }
  ]
}

允许的 kind：character_new、character_state、character_set、relationship、arc、objective、conflict、thread、foreshadowing、timeline。
relationship open 的 from/to 可以是已有 Cxx，也可以是本次请求刚刚定义的 N key；同一批次后续更新使用该 relationship 的 N key。
允许的 field：character_state 使用 location/physicalState/emotionalState/currentGoal/status；character_set 使用 alias/knowledge/possession/secret。
允许的 op：character_state=set/clear，character_set=add/remove，relationship=open/update，arc=start/update/complete/replace，objective=set/clear，conflict=open/update/resolve，thread=open/update/resolve，foreshadowing=open/update/partial/resolve，timeline=add。
`;

export const STORY_MEMORY_V2_LEGACY_BOOTSTRAP_NOTE =
  '这是历史摘要型输入，只提取文本明确表达的事实，不补全缺失剧情。';
