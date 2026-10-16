"use strict";

/*
 * extractDraft 纯函数 handler:event = { text },deps = { callLLM(promptText), logger }。
 * - 构造 system prompt(契约要点)与用户消息,组装成完整提示词交给 callLLM;
 * - 模型输出经 validateDraft 校验;JSON 解析失败会携带错误重试一次,仍失败返回 AI_UNAVAILABLE;
 * - callLLM 抛错(含超时、HTTP 非 200)返回 AI_UNAVAILABLE 且 manual_fallback 为 true;
 * - text 去空白后不在 1-500 字范围返回 INVALID_INPUT;
 * - 日志只记文本长度、耗时、错误码,绝不记录原文与提取结果。
 */

const { validateDraft, validateDrafts, applyRelativeConversion } = require("./validate");
const { shanghaiTodayYmd } = require("./relative-date");

const TEXT_MAX = 500;
const USER_MARKER = "【用户输入】";
const RETRY_OUTPUT_MARKER = "【上次输出】";
const RETRY_ERROR_MARKER = "【解析错误】";

const SYSTEM_PROMPT = [
  "你是家庭物品位置提取器。用户会用一句话描述一件物品及其位置,你只负责提取,不负责回答或闲聊。",
  "规则:",
  "1. 从这句话里提取一件物品的名称(name)与位置(location_text)。",
  "2. 位置必须来自原文,禁止猜测、推理或编造;不能确定位置时 certain 为 false,且 location_text 为空字符串。",
  "3. 「右边」「第二个」「最下层」等具有定位作用的方位/序号限定语放进 qualifiers 数组;「某个」「好像」「大概」等表示不确定的模糊词不是限定语,不要放进 qualifiers(certain 为 false 时 qualifiers 应为空数组)。",
  "4. 一句话里出现多件物品时 needs_split 为 true。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。字段:",
  "- name:字符串,不超过 50 字",
  "- location_text:字符串,不超过 200 字,可为空字符串",
  "- certain:布尔,表示位置是否肯定",
  "- qualifiers:字符串数组,每项不超过 20 字,最多 5 个",
  "- needs_split:布尔,默认 false",
].join("\n");

/*
 * 协议 v2(protocol:2):一句话可含多件物品,逐件提取并携带原话证据。
 * v1 客户端不传 protocol,继续走上面的单件协议(needs_split 行为不变,
 * v1 prompt 逐字节不变——旧客户端零感知)。
 * 提醒候选三项(remind_at/remind_kind/remind_quote)沿用 #36 冻结日期纪律:
 * 只接受原话里明确说了的绝对日期(至少有月和日),逐字锚定;模糊/相对/月精度/
 * 需换算的一律 null(日期由用户在确认页自己选);不存在「存日期但不提醒」模式。
 * mount_path(十七轮,#18 红线语义升级):「放进」路径预览——仅 certain=true 且
 * 分层明确时逐字投影(服务端硬门见 lib/validate.js validateMountPath);
 * 这是预览不是写入,用户点「确认记住」才由 locations.ensureAndLink 建路径挂上。
 * 方位后缀剥离(0.7.0 真机反馈 Fix 2):「冰箱里面有面条」的位置曾提取成
 * 「冰箱里面」——纯方位后缀(里/里面/上/左边…)不应留在位置实体名里。
 * 规则 2/9 要求模型对 location_text 与 mount_path 各段剥后缀、输出裸实体名
 * (冰箱/主卧/柜子);服务端校验零放松——剥后的段名/位置仍是原话逐字子串
 * (冰箱⊂冰箱里面,天然过既有有序锚定),source_quote/提醒/vague 字段零变化。
 * 相对时间换算(#36 真机反馈三件 A,产品拍板:产品换算,用户只确认):
 * prompt 第 7/8 条逐字不变(模型照旧只标 vague、绝不折算日期);组包处
 * (handler v2 成功分支)对「无绝对日期 + 有 vague」的 draft 逐件跑闭集
 * 换算器 lib/relative-date.js(锚点=提取时刻服务端今天 Asia/Shanghai)——
 * 成功 → remind_at=换算值 / remind_quote=vague 原文 / vague 置空 /
 * remind_converted:true(经 validate.applyRelativeConversion 复核硬门);
 * 闭集外(下个月/快过期了/月精度…)维持灰行现状。换算结果在确认卡
 * 是候选(可改可清),「不猜日期」的确认纪律不变。
 */
const SYSTEM_PROMPT_V2 = [
  "你是家庭物品位置提取器。用户会用一句话描述一件或多件物品及其位置,你只负责提取,不负责回答或闲聊。",
  "规则:",
  "1. 把这句话里的每一件物品都提取出来放进 items 数组(最多 5 件)。用户说了超过 5 件时,items 只放前 5 件,并把顶层 has_more 设为 true(其余件数不丢弃提示,由系统引导用户分批);不超过 5 件时 has_more 为 false。",
  "2. 每件物品包含名称(name)与位置(location_text)。位置必须来自原文,禁止猜测、推理或编造;location_text 只写位置实体本身——末尾不带「里」「里面」「上」「上面」「下面」「左边」这类纯方位后缀,把后缀剥掉、输出裸实体名(「冰箱里面有面条」→ location_text 为「冰箱」,「主卧的柜子上」→「主卧的柜子」);剥掉后缀后的位置仍必须逐字出现在原话中;不能确定某件的位置时,该件 certain 为 false 且 location_text 为空字符串。",
  "3. 多件物品共用一个位置是合法的(如「钥匙和充电宝都在玄关抽屉」,两件的位置都是「玄关抽屉」);按原文如实归属,不得擅自交叉配对;不确定归属时该件 certain 为 false。",
  "4. 每件带 source_quote:从用户原话里逐字摘录对应这件物品(含其位置,若适用)的最小片段;整句只说一件时可为整句。禁止改写或拼接原文。",
  "5. 「右边」「第二个」「最下层」等具有定位作用的方位/序号限定语放进该件的 qualifiers 数组;「某个」「好像」「大概」等模糊词不是限定语(certain 为 false 时 qualifiers 应为空数组)。",
  "6. 用户在这句话里明确说出了绝对日期(至少有「月」和「日」,如「11月20号过期」「2027年6月30号保修到期」)时,为对应物品给出提醒候选三项:remind_at 规范化为 YYYY-MM-DD;remind_kind ∈ 有效期(保质期/有效期/保修到期)/开封后(已开封,要在该日期前用完或吃完)/下次维护(下次要处理这件事的日子,如更换、清洗、归还、续约、寄出);remind_quote 为该日期在原话中的逐字子串(如「11月20号」)。用户没说年份时,按【今天】补全为最近的未来日期(今年的该月该日已过则用下一年)。",
  "7. 日期纪律(违反即不带提醒,物品与位置仍照常提取):只接受原话里明确说了的绝对日期。「下个月」「快过期了」「大概冬天」「差不多半年」等模糊表达,「下周三」「半年后」「每三个月」等相对表达,只说到月份的(如「保修到2027年3月」——日没说,由用户自己选),以及「生产日期是10月5号保质期六个月」「开封后三个月」这类要换算的(到期日不在原话),一律 remind_at=null、remind_kind=null、remind_quote=null。禁止根据物品名称猜任何日期、保质期或周期。",
  "8. 时间没换算的透明标记(只标记,绝不换算):用户在这句话里提到了时间、但按第 7 条不该换算成日期时(模糊/相对/月精度/需换算),把该时间表述在原话中的逐字子串放进对应物品的 remind_vague_quote(如「半年后」「下个月」「快过期了」)。没提到任何时间、或该件已按第 6 条给出 remind_at 三项时,remind_vague_quote 为 null。remind_vague_quote 不是日期、也绝不会被换算成日期——它只是把「用户说了时间、但系统没换算」如实标出来。",
  "9. 放进路径预览 mount_path:当某件的位置 certain 为 true、且能明确拆成「从大到小」的层级时,把每一层的名字逐字取自该件的 location_text、按原文顺序放进该件的 mount_path 数组(字符串数组,1-6 段,每段不超过 30 字,首段是房间或大区域;位置只有一层时就是单段数组,如「玄关」→ [\"玄关\"];多层如「主卧的柜子上」→ [\"主卧\",\"柜子\"])。每一段同样剥离段尾的纯方位后缀(里/里面/里边/内/中/上/上面/上边/下/下面/下边/左边/右边/左侧/右侧/中间/旁边/附近/上方/下方),输出裸实体名(「冰箱里面有面条」→ [\"冰箱\"])——剥掉后缀后的段名仍必须是原话的逐字子串(「冰箱」⊂「冰箱里面」,天然成立)。「上」「左边」这类纯方位词不能单独成一层,并入前一层实体即可。层级拆不明确、位置含「某个」「大概」等模糊说法、层次关系不清时,mount_path 为 null——绝不猜测、绝不编造层次,拿不准就给 null。certain 为 false 的物品 mount_path 必须为 null。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:",
  '{ "items": [ { "name": "…", "location_text": "…", "certain": true, "qualifiers": ["…"], "source_quote": "…", "remind_at": "2026-11-20", "remind_kind": "有效期", "remind_quote": "11月20号", "remind_vague_quote": null, "mount_path": ["主卧", "柜子"] } ], "has_more": false }',
  "字段:name 不超过 50 字;location_text 不超过 200 字,可为空字符串,不带纯方位后缀;certain 为布尔;qualifiers 每项不超过 20 字、最多 5 个;source_quote 不超过 200 字;has_more 为布尔;remind_at 形如 YYYY-MM-DD 或 null,与 remind_kind、remind_quote 同时出现或同时为 null(没有提醒时三项均为 null);remind_kind 只能是 有效期/开封后/下次维护 之一或 null;remind_quote 不超过 200 字,必须是原话逐字子串;remind_vague_quote 不超过 200 字,必须是原话里时间表述的逐字子串,只在 remind_at 为 null 且确有时间表述时给出,否则为 null;mount_path 为字符串数组(1-6 段,每段 1-30 字、逐字取自该件 location_text、按原文顺序、首段为房间或大区域、段名不带纯方位后缀)或 null(certain 为 false、分层不明确或模糊时必须为 null)。",
].join("\n");

const TODAY_MARKER = "【今天】";

function codePointLength(s) {
  return Array.from(s).length;
}

function stripAllWhitespace(s) {
  return s.replace(/\s+/g, "");
}

/*
 * 今天的 YYYY-MM-DD(本地时区):仅供 v2 prompt 里无年份日期的补全基准,
 * 与 #36 纪律一致——AI 只提取原话日期,不推算相对周期。
 */
function formatToday(input) {
  let d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) d = new Date();
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function buildPrompt(userText, retryInfo, systemPrompt) {
  const prompt0 = systemPrompt || SYSTEM_PROMPT;
  let prompt = prompt0 + "\n\n" + USER_MARKER + "\n" + userText;
  if (retryInfo) {
    prompt +=
      "\n\n" +
      RETRY_OUTPUT_MARKER +
      "\n" +
      retryInfo.previousOutput +
      "\n" +
      RETRY_ERROR_MARKER +
      "\n" +
      retryInfo.reason +
      "\n请重新输出,只输出一个符合上述字段要求的 JSON 对象,不要包含任何其他文字或代码块围栏。";
  }
  return prompt;
}

function invalidInputResult() {
  return {
    ok: false,
    error: "INVALID_INPUT",
    message: "请输入一句话描述物品和位置(去空白后 1-500 字)",
  };
}

function aiUnavailableResult() {
  return {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "AI 暂时不可用,可手动录入",
    manual_fallback: true,
  };
}

async function handler(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  const elapsedMs = () => Date.now() - startedAt;

  const rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logger({ textLength: 0, elapsedMs: elapsedMs(), error: "INVALID_INPUT" });
    return invalidInputResult();
  }
  const textLength = codePointLength(stripAllWhitespace(rawText));
  if (textLength < 1 || textLength > TEXT_MAX) {
    logger({ textLength, elapsedMs: elapsedMs(), error: "INVALID_INPUT" });
    return invalidInputResult();
  }

  const userText = rawText.trim();
  // 协议路由:显式 protocol:2 走多件拆分;其余(含旧客户端)维持 v1 单件行为。
  const isV2 = event !== null && typeof event === "object" && event.protocol === 2;
  // v2 追加今天日期(仅 v2;v1 prompt 逐字节不变),供「11月20号」这类没说年份的
  // 绝对日期补全为最近的未来日期。同一份今天也传给 validateDrafts:服务端
  // 对应锚定按同款规则补全无年份日期,与 prompt 给模型的口径一致。
  // 测试经 deps.today 注入固定值。
  // 相对时间换算锚点(#36 真机反馈三件 A)另取提取时刻的服务端今天
  // (Asia/Shanghai,UTC+8 固定偏移——云函数运行时区默认 UTC,北京 0-8 点的
  // 「今天」绝不能被折早一天);deps.anchorToday 可注入固定锚点(测试用)。
  let systemPrompt;
  let todayYmd = null;
  let anchorYmd = null;
  if (isV2) {
    const today = deps && typeof deps.today === "function" ? deps.today() : new Date();
    todayYmd = formatToday(today);
    systemPrompt = SYSTEM_PROMPT_V2 + "\n" + TODAY_MARKER + todayYmd;
    anchorYmd =
      deps && typeof deps.anchorToday === "function"
        ? deps.anchorToday()
        : shanghaiTodayYmd(today instanceof Date ? today : new Date(today));
  } else {
    systemPrompt = SYSTEM_PROMPT;
  }

  let output;
  try {
    output = await callLLM(buildPrompt(userText, null, systemPrompt));
  } catch (e) {
    logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
    return aiUnavailableResult();
  }

  let result = isV2 ? validateDrafts(output, userText, todayYmd) : validateDraft(output, userText);
  if (!result.ok && result.retryable) {
    // JSON 解析失败:带错误提示回传 LLM,只重试一次。
    let retryOutput;
    try {
      retryOutput = await callLLM(
        buildPrompt(userText, { previousOutput: output, reason: result.reason }, systemPrompt)
      );
    } catch (e) {
      logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
      return aiUnavailableResult();
    }
    result = isV2 ? validateDrafts(retryOutput, userText, todayYmd) : validateDraft(retryOutput, userText);
  }

  if (result.ok) {
    logger({ textLength, elapsedMs: elapsedMs() });
    if (isV2) {
      // #36 真机反馈三件 A(产品拍板:产品换算,用户只确认):组包处逐件对
      // 「未取到绝对日期且带 vague 标记」的 draft 跑闭集换算——成功则
      // remind_at=换算值、remind_quote=vague 原文(锚定仍在原话)、
      // remind_vague_quote 置空、remind_converted:true;闭集外维持灰行现状。
      // prompt 规则逐字不变(模型仍按第 7/8 条产出 vague),换算全在服务端。
      // 换算结果是确认卡上的候选(可改可清),不是替代用户确认。
      const drafts = anchorYmd === null
        ? result.drafts
        : result.drafts.map((d) => applyRelativeConversion(d, stripAllWhitespace(userText), anchorYmd));
      return {
        ok: true,
        drafts,
        original_text: userText,
        truncated: result.truncated === true,
      };
    }
    return result;
  }
  logger({ textLength, elapsedMs: elapsedMs(), error: "AI_UNAVAILABLE" });
  return aiUnavailableResult();
}

module.exports = { handler, buildPrompt, SYSTEM_PROMPT, SYSTEM_PROMPT_V2 };
