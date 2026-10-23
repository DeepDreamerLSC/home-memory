"use strict";

/*
 * extractDraft 纯函数 handler:event = { text },deps = { callLLM(promptText), callLocalLLM(promptText)?, logger }。
 * - 构造 system prompt(契约要点)与用户消息,组装成完整提示词交给引擎;
 * - 模型输出经 validateDraft 校验;JSON 解析失败会携带错误重试一次,仍失败返回 AI_UNAVAILABLE;
 * - 引擎抛错(含超时、HTTP 非 200)返回 AI_UNAVAILABLE 且 manual_fallback 为 true;
 * - text 去空白后不在 1-500 字范围返回 INVALID_INPUT;
 * - 日志只记文本长度、耗时、错误码与 engine 计数(降级另记布尔),绝不记录原文与提取结果。
 *
 * 本地主路 + DeepSeek 兜底(issue #36 本地 A3B,2026-10-16):
 * deps.callLocalLLM 是可选依赖,仅当胶水层判定 lib/local-llm.js isConfigured()
 * (LOCAL_LLM_BASE/TOKEN/MODEL 三件套齐全)时注入。注入时:
 *   - 先走本地(家里 mlx 单点,快),成功(返回非空文本)→ 结果进既有解析/校验/
 *     重试链路,prompt 级重试照旧仍走本地;
 *   - 本地引擎失败(网络错误/超时/HTTP 非 200/空文本)→ 立即降级 DeepSeek 重跑
 *     同一既有链路,内测用户无感;
 *   - 两者都失败 → 既有 AI_UNAVAILABLE 路径不变。
 * 未注入时只有 DeepSeek 一个引擎,请求次数与行为与历史逐字节一致(回归锁)。
 * 响应顶层带 engine:"local"|"deepseek"(客户端忽略未知字段,零客户端改动);
 * AI_UNAVAILABLE 从引擎失败来时 engine 记最后尝试的引擎,模型质量失败(坏 JSON
 * 两次)记该引擎本身——降级只救「引擎不可用」,不救「模型输出不合格」。
 */

const { validateDraft, validateDrafts, applyRelativeConversion } = require("./validate");
const { shanghaiTodayYmd } = require("./relative-date");
const { normalizeVlBox, BOX_SCALE } = require("./vl");
// 冻结数字解析器(§7.8.2,唯一数字语义实现):quantityIntentParse 的数字锚定
// 与 v2 数量三项(validate.js)共用同一实现,绝不各写一份。
const { parseQuantityQuote, UNIT_SET } = require("./quantity");

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
  "10. 数量候选三项(只提取,绝不推算):用户在这句话里明确说出了某件物品的数量和单位(单位只能是 件/个/包/盒/瓶/袋/支/双/套/卷/张/本/罐/只 之一,如「买了三包棉柔巾」「两盒抽纸」)时,为该件给出 quantity(整数,1-9999)、unit(上述单位之一)、quantity_quote(原话中承载该数量的逐字子串,如「三包」「3包」)。没说数量、说的是「几包」「一些」「半打」这类模糊量、单位不在上述列表(如「一箱」「一打」「500ml」)、或需要换算(「一箱 24 包」不得折成 24)时,三项一律为 null。「买了」「新增」只说明这是新记一件,不代表要加到已有的记录上。禁止根据物品名称或常识猜任何数量。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:",
  '{ "items": [ { "name": "…", "location_text": "…", "certain": true, "qualifiers": ["…"], "source_quote": "…", "remind_at": "2026-11-20", "remind_kind": "有效期", "remind_quote": "11月20号", "remind_vague_quote": null, "mount_path": ["主卧", "柜子"], "quantity": 3, "unit": "包", "quantity_quote": "三包" } ], "has_more": false }',
  "字段:name 不超过 50 字;location_text 不超过 200 字,可为空字符串,不带纯方位后缀;certain 为布尔;qualifiers 每项不超过 20 字、最多 5 个;source_quote 不超过 200 字;has_more 为布尔;remind_at 形如 YYYY-MM-DD 或 null,与 remind_kind、remind_quote 同时出现或同时为 null(没有提醒时三项均为 null);remind_kind 只能是 有效期/开封后/下次维护 之一或 null;remind_quote 不超过 200 字,必须是原话逐字子串;remind_vague_quote 不超过 200 字,必须是原话里时间表述的逐字子串,只在 remind_at 为 null 且确有时间表述时给出,否则为 null;mount_path 为字符串数组(1-6 段,每段 1-30 字、逐字取自该件 location_text、按原文顺序、首段为房间或大区域、段名不带纯方位后缀)或 null(certain 为 false、分层不明确或模糊时必须为 null);quantity 为 1-9999 整数或 null,与 unit、quantity_quote 同时出现或同时为 null(没说数量时三项均为 null);unit 只能是 件/个/包/盒/瓶/袋/支/双/套/卷/张/本/罐/只 之一或 null;quantity_quote 不超过 200 字,必须是原话里数量表述的逐字子串。",
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

function aiUnavailableResult(engine) {
  const result = {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "AI 暂时不可用,可手动录入",
    manual_fallback: true,
  };
  if (engine) result.engine = engine;
  return result;
}

async function handler(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  // 本地主路引擎(可选):未注入时只有 DeepSeek,行为与历史逐字节一致。
  const callLocalLLM =
    deps && typeof deps.callLocalLLM === "function" ? deps.callLocalLLM : null;
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

  /*
   * 单引擎执行链:把既有「调用 → 校验 → JSON 解析失败带错误重试一次 → 再校验」
   * 链路按引擎收敛成可换引擎执行的单元。engineFailed = 引擎层失败(网络错误/
   * 超时/HTTP 非 200/空文本),由外层决定是否换兜底引擎重跑;模型质量失败
   * (坏 JSON 重试后仍不合格)不是引擎失败,不触发降级。
   * emptyOutputIsFailure 仅本地引擎启用(实测:思考档误开时 content 为空,
   * 视为引擎失败立即降级);DeepSeek 维持历史口径——空文本进解析 → 可重试 →
   * 重试,保证未配置本地时行为与 main 逐字节一致(回归锁)。
   */
  const validateOutput = (output) =>
    isV2 ? validateDrafts(output, userText, todayYmd) : validateDraft(output, userText);

  const runEngineChain = async (callFn, emptyOutputIsFailure) => {
    const isEmptyFailure = (output) =>
      emptyOutputIsFailure && (typeof output !== "string" || output.trim() === "");
    let output;
    try {
      output = await callFn(buildPrompt(userText, null, systemPrompt));
    } catch (e) {
      return { engineFailed: true };
    }
    if (isEmptyFailure(output)) {
      return { engineFailed: true };
    }
    let result = validateOutput(output);
    if (!result.ok && result.retryable) {
      // JSON 解析失败:带错误提示回传同一引擎,只重试一次。
      let retryOutput;
      try {
        retryOutput = await callFn(
          buildPrompt(userText, { previousOutput: output, reason: result.reason }, systemPrompt)
        );
      } catch (e) {
        return { engineFailed: true };
      }
      if (isEmptyFailure(retryOutput)) {
        return { engineFailed: true };
      }
      result = validateOutput(retryOutput);
    }
    return { engineFailed: false, result };
  };

  let engine = "deepseek";
  let localAttempted = false;
  let chain;
  if (callLocalLLM) {
    engine = "local";
    localAttempted = true;
    chain = await runEngineChain(callLocalLLM, true);
    if (chain.engineFailed) {
      // 本地单点失守(家里机器不在线/超时/网关错误):立即降级 DeepSeek,
      // 重跑同一既有链路;降级只记布尔标记,不记任何失败详情。
      engine = "deepseek";
      chain = await runEngineChain(callLLM, false);
    }
  } else {
    chain = await runEngineChain(callLLM, false);
  }
  const fellBackToLocalFailure = localAttempted && engine === "deepseek";
  // 日志白名单:文本长度、耗时、错误码、engine 计数、降级布尔——仅此而已。
  const logMeta = (extra) => {
    const meta = Object.assign({ textLength, elapsedMs: elapsedMs() }, extra, { engine });
    if (fellBackToLocalFailure) meta.localFallback = true;
    return meta;
  };

  let result = chain.result;
  if (!chain.engineFailed && result.ok) {
    logger(logMeta({}));
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
        engine,
      };
    }
    // v1 成功形状零变化,仅顶层加 engine(客户端忽略未知字段)。
    return Object.assign({}, result, { engine });
  }
  logger(logMeta({ error: "AI_UNAVAILABLE" }));
  return aiUnavailableResult(engine);
}

// ---------- 拍照识物(#3):vlRecognize 视觉识别 + draftEditParse 语音受限编辑 ----------
//
// 两个新分支与既有提取路径完全隔离:既有 handler(无 action 事件)逐字节不变
// (现状锁);胶水层 index.js 按 event.action 路由到这两个函数。
// 红线(IMPLEMENTATION §1.1/§1.2/§11):两分支均为无状态服务,无 DB 客户端、
// 无 openid 依赖、不引入家庭解析;VL 链路不接 DeepSeek 降级(无视觉模型);
// 日志只记计数与错误码,绝不落 base64、识别结果、prompt 原文、转写原文、候选名。

const VL_IMG_DIM_MAX = 10000;
/**
 * image_base64 字符数上限(PR #67 B5):腾讯云开发 callFunction 事件整体上限 5MB,
 * 4,000,000 字符(≈3.83MB UTF-8)为事件 JSON 外壳(action/img_w/img_h 等字段)
 * 留余量——原 10MB 解码门在 5MB 事件上限下形同虚设(超限请求根本到不了函数)。
 * 超出直接拒绝,不解码。
 */
const VL_MAX_IMAGE_BASE64_CHARS = 4000000;
/** 裸 base64(无 data: 前缀、无换行/空白;小程序 readFile encoding:"base64" 的原样产物) */
const VL_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const VL_MAX_ITEMS = 10;
const VL_NAME_MAX = 50;
const VL_QTY_NOTE_MAX = 40;
const VL_CONFIDENCE_KINDS = ["high", "mid", "low"];

/*
 * 坐标量纲声明(§3.1:这是模型输出唯一合法量纲,逐字写进提示词):
 * 「box 为 [x1,y1,x2,y2] 四个 0-1000 的整数,归一化到图片宽高,(0,0) 在左上角,
 * x1<x2,y1<y2。看不清的也输出,confidence 给 "low"。'
 * 上限 10 件;品牌可辨就用「品牌+品类」(品客薯片罐),否则外观描述(黄色薯片罐)。
 */
const VL_SYSTEM_PROMPT = [
  "你是家庭物品识别器。照片是家中一个收纳空间(抽屉/柜子)的照片,请找出照片里全部可辨认的物品。",
  "规则:",
  "1. 每件物品输出 name(中文名称,不超过 50 字;能认出品牌就用「品牌+品类」,如「品客薯片罐」,认不出就用外观描述,如「黄色薯片罐」)、qty_note(数量线索按原样保留,如「约2根」「两节」,没有就给空字符串)、confidence(\"high\"|\"mid\"|\"low\")、box。",
  "2. box 为 [x1,y1,x2,y2] 四个 0-1000 的整数,归一化到图片宽高,(0,0) 在左上角,x1<x2,y1<y2。看不清的也输出,confidence 给 \"low\"。",
  "3. 最多输出 10 件物品。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:",
  '{ "items": [ { "name": "…", "qty_note": "…", "confidence": "mid", "box": [x1,y1,x2,y2] } ] }',
].join("\n");

/** mode="region" 时追加的圈选上下文(0-1 上送,×1000 写进提示词,屏⑤语义) */
function buildVlPrompt(mode, region) {
  let prompt = VL_SYSTEM_PROMPT;
  if (mode === "region" && region) {
    prompt +=
      "\n用户圈出的区域(0-1000 坐标)x1=" + Math.round(region.x1 * BOX_SCALE) +
      ",y1=" + Math.round(region.y1 * BOX_SCALE) +
      ",x2=" + Math.round(region.x2 * BOX_SCALE) +
      ",y2=" + Math.round(region.y2 * BOX_SCALE) +
      ",请优先识别该区域内的物品,结合整张照片一起判断。";
  }
  return prompt;
}

/** 从模型原始输出提取 JSON 对象(容忍围栏与前后废话;与 lib/validate.js 同款逻辑) */
function extractJsonObject(rawText) {
  if (typeof rawText !== "string") return undefined;
  const trimmed = rawText.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    /* 继续尝试截取 */
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last <= first) return undefined;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch (e) {
    return undefined;
  }
}

function vlInvalidInputResult() {
  return { ok: false, error: "INVALID_INPUT", message: "照片参数不合法" };
}

/** VL 链路统一不可用形态(无降级引擎;manual_fallback 让客户端走手动添加) */
function vlUnavailableResult(reason) {
  return {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "拍照识别暂不可用,可手动添加",
    manual_fallback: true,
    engine: "vl-local",
    reason: reason,
  };
}

/** mode="region" 的圈选框校验:四值有限数 ∈[0,1] 且 x2>x1、y2>y1;非法返回 null */
function validVlRegion(region) {
  if (region === null || typeof region !== "object" || Array.isArray(region)) return null;
  const keys = ["x1", "y1", "x2", "y2"];
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const v = region[keys[i]];
    if (typeof v !== "number" || !isFinite(v) || v < 0 || v > 1) return null;
    out[keys[i]] = v;
  }
  if (!(out.x2 > out.x1) || !(out.y2 > out.y1)) return null;
  return out;
}

/*
 * 模型输出校验与清洗(§1.1 响应保证):
 * - 顶层不是 JSON 对象 / items 不是数组 → retryable(handler 带错误重试一次);
 * - 单件清洗:name 非字符串/去空白为空/超 50 码点 → 丢弃该件(绝不半带);
 *   qty_note 非字符串 → 空串,超 40 码点截断;confidence 词表外按 "low";
 *   box 经 normalizeVlBox(0-1000 整数门)归一为 0-1,任一条件不满足 → null
 *   (越界=不可信=丢框,物品候选保留);
 * - 超过 10 件只取前 10,响应带 truncated:true(如实截断)。
 */
function validateVlOutput(rawText) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (!Array.isArray(parsed.items)) {
    return { ok: false, retryable: true, reason: "items 字段缺失或不是数组" };
  }
  const truncated = parsed.items.length > VL_MAX_ITEMS;
  const items = [];
  for (const raw of parsed.items.slice(0, VL_MAX_ITEMS)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (typeof raw.name !== "string") continue;
    const name = raw.name.trim();
    if (codePointLength(name) < 1 || codePointLength(name) > VL_NAME_MAX) continue;
    let qtyNote = "";
    if (typeof raw.qty_note === "string") {
      qtyNote = Array.from(raw.qty_note.trim()).slice(0, VL_QTY_NOTE_MAX).join("");
    }
    const confidence = VL_CONFIDENCE_KINDS.indexOf(raw.confidence) !== -1 ? raw.confidence : "low";
    items.push({ name: name, qty_note: qtyNote, confidence: confidence, box: normalizeVlBox(raw.box) });
  }
  return { ok: true, items: items, truncated: truncated };
}

/*
 * vlRecognize(§1.1 执行链,依赖全部注入便于离线测试):
 * 隐私红线(#65 V0.4 合同第五项边界):照片在用户最终确认保存之前绝不上传云端——
 * 识别只收客户端本地压缩图的 base64(与 transcribe 音频 base64 直传同款先例),
 * 本函数不读云存储、不落任何持久层;上传只发生在用户确认后的保存流程(photoCommit)。
 * 1. 形状校验(image_base64/img_w/img_h/mode/region,任一不过 → INVALID_INPUT):
 *    image_base64 须为裸 base64(无 data: 前缀/空白),长度 ≤4,000,000 字符、解码 ≥1 字节
 *    (超过 → INVALID_INPUT,客户端提示重拍;解码前先按长度上界廉价拒绝);
 * 2. deps.callVL 未注入(三件套缺任一,胶水层据此不注入)→ AI_UNAVAILABLE
 *    reason:"vl_not_configured" + manual_fallback(engine unavailable,不抛错);
 * 3. 调用 → validateVlOutput 校验 → JSON 失败带错误重试一次(同提取链路口径),
 *    仍败/引擎抛错 → AI_UNAVAILABLE(engine:"vl-local",无降级引擎)。
 * 日志只记 {action, elapsedMs, engine, itemcount, error?, reason?}(计数与错误码),
 * 绝不落 base64(含长度之外的任何内容)、识别结果、prompt 原文。
 */
async function vlRecognize(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const elapsedMs = () => Date.now() - startedAt;
  const logMeta = (extra) =>
    Object.assign({ action: "vlRecognize", elapsedMs: elapsedMs(), engine: "vl-local" }, extra);

  const imageBase64 = event && typeof event.image_base64 === "string" ? event.image_base64 : null;
  if (
    imageBase64 === null ||
    imageBase64.length < 1 ||
    imageBase64.length > VL_MAX_IMAGE_BASE64_CHARS ||
    !VL_BASE64_RE.test(imageBase64)
  ) {
    logger(logMeta({ error: "INVALID_INPUT" }));
    return vlInvalidInputResult();
  }
  const imgW = event ? event.img_w : undefined;
  if (!Number.isInteger(imgW) || imgW < 1 || imgW > VL_IMG_DIM_MAX) {
    logger(logMeta({ error: "INVALID_INPUT" }));
    return vlInvalidInputResult();
  }
  const imgH = event ? event.img_h : undefined;
  if (!Number.isInteger(imgH) || imgH < 1 || imgH > VL_IMG_DIM_MAX) {
    logger(logMeta({ error: "INVALID_INPUT" }));
    return vlInvalidInputResult();
  }
  let mode = "full";
  if (event && event.mode !== undefined && event.mode !== null) {
    if (event.mode !== "full" && event.mode !== "region") {
      logger(logMeta({ error: "INVALID_INPUT" }));
      return vlInvalidInputResult();
    }
    mode = event.mode;
  }
  let region = null;
  if (mode === "region") {
    region = validVlRegion(event.region);
    if (region === null) {
      logger(logMeta({ error: "INVALID_INPUT" }));
      return vlInvalidInputResult();
    }
  }

  // 解码只为丈量字节数(0 字节门;长度上界已在字符门先行裁定);上送 VL 的
  // 仍是客户端原样 base64,不再二次编码。
  const imageBytes = Buffer.byteLength(imageBase64, "base64");
  if (imageBytes < 1) {
    logger(logMeta({ error: "INVALID_INPUT" }));
    return vlInvalidInputResult();
  }

  const callVL = deps && typeof deps.callVL === "function" ? deps.callVL : null;
  if (!callVL) {
    logger(logMeta({ error: "AI_UNAVAILABLE", reason: "vl_not_configured" }));
    return vlUnavailableResult("vl_not_configured");
  }

  const retryPrompt = (previousOutput, reason) =>
    buildVlPrompt(mode, region) +
    "\n\n" +
    RETRY_OUTPUT_MARKER +
    "\n" +
    previousOutput +
    "\n" +
    RETRY_ERROR_MARKER +
    "\n" +
    reason +
    "\n请重新输出,只输出一个符合上述字段要求的 JSON 对象,不要包含任何其他文字或代码块围栏。";

  let output;
  try {
    output = await callVL(buildVlPrompt(mode, region), imageBase64);
  } catch (e) {
    logger(logMeta({ error: "AI_UNAVAILABLE", reason: "vl_call_failed" }));
    return vlUnavailableResult("vl_call_failed");
  }
  let result = validateVlOutput(output);
  if (!result.ok && result.retryable) {
    let retryOutput;
    try {
      retryOutput = await callVL(retryPrompt(output, result.reason), imageBase64);
    } catch (e) {
      logger(logMeta({ error: "AI_UNAVAILABLE", reason: "vl_call_failed" }));
      return vlUnavailableResult("vl_call_failed");
    }
    result = validateVlOutput(retryOutput);
    if (!result.ok) {
      logger(logMeta({ error: "AI_UNAVAILABLE", reason: "vl_bad_output" }));
      return vlUnavailableResult("vl_bad_output");
    }
  }

  logger(logMeta({ itemcount: result.items.length }));
  const res = { ok: true, engine: "vl-local", items: result.items, img_w: imgW, img_h: imgH };
  if (result.truncated) res.truncated = true;
  return res;
}

// ---------- draftEditParse(语音受限编辑解析,§1.2) ----------

const EDIT_TEXT_MAX = 200;
const EDIT_LOCATION_MAX = 200;
const EDIT_CANDIDATES_MIN = 1;
const EDIT_CANDIDATES_MAX = 12;
// draft_id 上限 64:客户端 intake-draft 用 uuid()(v4,36 位)生成候选 id,
// 32 会把真实页面的全部候选判非法(INVALID_INPUT→客户端稳定「没听懂」,
// 0.9.8 真机事故 2026-10-17);与 api.ts operation_id「≤64」契约对齐。
const EDIT_DRAFT_ID_MAX = 64;
const EDIT_NAME_MAX = 50;
const EDIT_VALUE_MAX = 200;
const EDIT_EDITS_MAX = 3;
const EDIT_QTY_NOTE_MAX = 40;
const EDIT_INTENTS = ["edit", "add", "batch_location", "none"];
const EDIT_FIELDS = ["name", "qty_note", "location"];

/*
 * 解析器提示词要点(§1.2):只解析不回答;按内容词对候选(绝不按「第N个」行号,
 * 用户删行重排后行号会漂移);三类操作一句话只取最主要的一类(单意图返回,
 * diff 弹层一次处理一个意图);对不上唯一候选 needs_pick;只输出 JSON。
 */
const EDIT_SYSTEM_PROMPT = [
  "你是照片候选清单的语音编辑解析器。用户对着一张照片候选清单说了一句话,你只负责把这句话解析成编辑指令,不负责回答或闲聊。",
  "规则:",
  "1. 按【内容词】把用户话里的物品对应到【候选清单】中的某一件(名称相近即可,如「品客的薯片罐」→「黄色薯片罐」);绝不按「第N个」这类行号或顺序锁定(用户删行重排后行号会漂移)。",
  "2. 三类操作:改某件候选的字段(intent=\"edit\",edits 每项 field 只能是 name/qty_note/location);补一件清单里没有的物品(intent=\"add\");改整批默认位置(intent=\"batch_location\")。一句话里同时含多类时只取最主要的一类,其余忽略。",
  "3. 对不上唯一候选时 needs_pick 为 true,并把可能的候选放进 picks;绝不猜、绝不执行对不上的指令。",
  "4. 没解析出任何操作(闲聊/无关/信息不足)时 intent=\"none\"。",
  "只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:",
  '{ "intent": "edit", "target": { "draft_id": "…", "matched_word": "…" }, "edits": [ { "field": "name", "old": "…", "new": "…" } ], "added": { "name": "…", "qty_note": "…" }, "new_location": "…", "needs_pick": false, "picks": [ { "draft_id": "…", "name": "…" } ] }',
  "字段:intent ∈ edit/add/batch_location/none;target.draft_id 必须来自【候选清单】;matched_word 是用户话里锁定该件的内容词(不超过 200 字);edits 最多 3 项,old 是该字段当前值(仅展示),new 是新值(不超过 200 字);intent=\"add\" 时 added.name 不超过 50 字;intent=\"batch_location\" 时 new_location 不超过 200 字;needs_pick 为 true 时 target 与 edits 必须为空。",
].join("\n");

function editInvalidInputResult() {
  return { ok: false, error: "INVALID_INPUT", message: "语音编辑指令不合法" };
}

function buildDraftEditPrompt(userText, batchLocation, candidates, retryInfo) {
  const candLines = candidates.map((c) => "- " + c.draft_id + ":" + c.name).join("\n");
  let prompt =
    EDIT_SYSTEM_PROMPT +
    "\n\n【当前批次位置】\n" +
    batchLocation +
    "\n\n【候选清单】\n" +
    candLines +
    "\n\n" +
    USER_MARKER +
    "\n" +
    userText;
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

/*
 * 模型输出校验 + 服务端硬门(§1.2,不信任模型输出):
 * - 顶层不是 JSON 对象 → retryable(handler 带错误重试一次);
 * - edits:field ∈ {name,qty_note,location} 白名单、new 非空 ≤200 码点、
 *   old ≤200(仅展示用)、数组 ≤3 项超出截断;非法项丢弃绝不半带;
 * - intent="edit" 时 target.draft_id 必须 ∈ candidates:不在/缺失 → 服务端
 *   强制改判 needs_pick=true、picks=candidates 全量、edits=[](没对上就不改);
 * - intent="add" 时 added.name 非空 ≤50,否则降级 intent="none";
 *   intent="batch_location" 时 new_location 非空 ≤200,否则降级 "none";
 * - needs_pick=true 时 edits 恒为空、target 恒为 null(形状互斥,客户端不做
 *   二次判断);picks 过滤到候选清单内,模型没给可用的就给全量。
 */
function validateDraftEditOutput(rawText, candidates) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  const byId = Object.create(null);
  for (const c of candidates) byId[c.draft_id] = c;

  let intent = parsed.intent;
  if (EDIT_INTENTS.indexOf(intent) === -1) intent = "none";

  let needsPick = parsed.needs_pick === true;
  if (intent === "none") needsPick = false;

  let edits = [];
  if (intent === "edit" && !needsPick && Array.isArray(parsed.edits)) {
    for (const e of parsed.edits) {
      if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
      if (EDIT_FIELDS.indexOf(e.field) === -1) continue;
      if (typeof e.new !== "string") continue;
      const nv = e.new.trim();
      if (nv === "" || codePointLength(nv) > EDIT_VALUE_MAX) continue;
      const ov = typeof e.old === "string" ? e.old.trim() : "";
      if (codePointLength(ov) > EDIT_VALUE_MAX) continue;
      edits.push({ field: e.field, old: ov, new: nv });
      if (edits.length >= EDIT_EDITS_MAX) break;
    }
  }

  let target = null;
  if (intent === "edit" && !needsPick) {
    const t = parsed.target;
    if (
      t !== null &&
      typeof t === "object" &&
      !Array.isArray(t) &&
      typeof t.draft_id === "string" &&
      byId[t.draft_id]
    ) {
      const mw = typeof t.matched_word === "string" ? t.matched_word.trim() : "";
      target = { draft_id: t.draft_id, matched_word: codePointLength(mw) > EDIT_VALUE_MAX ? "" : mw };
    } else {
      // 锁定依据不在候选清单:绝不执行,强制点选(picks=全量)
      needsPick = true;
      edits = [];
    }
  }

  let added = null;
  if (intent === "add" && !needsPick) {
    const a = parsed.added;
    if (a !== null && typeof a === "object" && !Array.isArray(a) && typeof a.name === "string") {
      const an = a.name.trim();
      if (an !== "" && codePointLength(an) <= EDIT_NAME_MAX) {
        let qn = "";
        if (typeof a.qty_note === "string") {
          qn = Array.from(a.qty_note.trim()).slice(0, EDIT_QTY_NOTE_MAX).join("");
        }
        added = { name: an, qty_note: qn };
      }
    }
    if (!added) intent = "none";
  }

  let newLocation = null;
  if (intent === "batch_location" && !needsPick) {
    if (typeof parsed.new_location === "string") {
      const nl = parsed.new_location.trim();
      if (nl !== "" && codePointLength(nl) <= EDIT_LOCATION_MAX) newLocation = nl;
    }
    if (!newLocation) intent = "none";
  }

  let picks = [];
  if (needsPick) {
    if (Array.isArray(parsed.picks)) {
      for (const p of parsed.picks) {
        if (
          p !== null &&
          typeof p === "object" &&
          typeof p.draft_id === "string" &&
          byId[p.draft_id]
        ) {
          picks.push({ draft_id: p.draft_id, name: byId[p.draft_id].name });
        }
      }
    }
    if (picks.length === 0) {
      picks = candidates.map((c) => ({ draft_id: c.draft_id, name: c.name }));
    }
  }

  return {
    ok: true,
    parsed: {
      intent: intent,
      target: target,
      edits: edits,
      added: added,
      new_location: newLocation,
      needs_pick: needsPick,
      picks: picks,
    },
  };
}

/** 五分支响应组装(§1.2;needs_pick 形状互斥:target null、edits 恒空) */
function draftEditResponse(engine, parsed) {
  if (parsed.needs_pick) {
    return {
      ok: true,
      engine: engine,
      intent: parsed.intent,
      target: null,
      edits: [],
      needs_pick: true,
      picks: parsed.picks,
    };
  }
  const base = { ok: true, engine: engine, intent: parsed.intent, needs_pick: false, picks: [] };
  if (parsed.intent === "edit") {
    base.target = parsed.target;
    base.edits = parsed.edits;
  } else if (parsed.intent === "add") {
    base.added = parsed.added;
  } else if (parsed.intent === "batch_location") {
    base.new_location = parsed.new_location;
  }
  return base;
}

/*
 * draftEditParse 入口:服务端不存草稿,候选清单由客户端随 event 传入。
 * 校验(text 去空白 1-200 码点 / batch_location 1-200 / candidates 1-12 项、
 * draft_id ≤32、name 1-50)失败 → INVALID_INPUT(引擎未参与)。
 * 引擎链复用既有 local→DeepSeek 双引擎降级形态(DeepSeek 是纯文本任务的合法
 * 兜底):local 失败(网络/超时/HTTP 非 200/空文本)立即降级;坏 JSON 带错误
 * 重试一次仍走同一引擎(模型质量失败不触发降级);双失败/坏输出 → AI_UNAVAILABLE。
 * 绝不触任何写:本函数无 DB 客户端、无 openid 依赖(结构上不可能写)。
 * 日志只记 {action, textLength, candidateCount, elapsedMs, engine, intent, error?},
 * 绝不记原文/候选名/edits。
 */
async function draftEditParse(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  const callLocalLLM =
    deps && typeof deps.callLocalLLM === "function" ? deps.callLocalLLM : null;
  const elapsedMs = () => Date.now() - startedAt;

  const rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logger({ action: "draftEditParse", textLength: 0, candidateCount: 0, elapsedMs: elapsedMs(), intent: null, error: "INVALID_INPUT" });
    return editInvalidInputResult();
  }
  const textLength = codePointLength(stripAllWhitespace(rawText));
  const userText = rawText.trim();

  const rawCandidates = event ? event.candidates : null;
  const candidateCount = Array.isArray(rawCandidates) ? rawCandidates.length : 0;
  const failInput = () => {
    logger({ action: "draftEditParse", textLength: textLength, candidateCount: candidateCount, elapsedMs: elapsedMs(), intent: null, error: "INVALID_INPUT" });
    return editInvalidInputResult();
  };

  if (textLength < 1 || textLength > EDIT_TEXT_MAX) return failInput();

  const batchLocation =
    event && typeof event.batch_location === "string" ? event.batch_location.trim() : null;
  if (batchLocation === null || batchLocation === "" || codePointLength(batchLocation) > EDIT_LOCATION_MAX) {
    return failInput();
  }
  if (!Array.isArray(rawCandidates) || rawCandidates.length < EDIT_CANDIDATES_MIN || rawCandidates.length > EDIT_CANDIDATES_MAX) {
    return failInput();
  }
  const candidates = [];
  for (const c of rawCandidates) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return failInput();
    if (typeof c.draft_id !== "string" || c.draft_id.length < 1 || c.draft_id.length > EDIT_DRAFT_ID_MAX) {
      return failInput();
    }
    if (typeof c.name !== "string") return failInput();
    const nm = c.name.trim();
    if (nm === "" || codePointLength(nm) > EDIT_NAME_MAX) return failInput();
    candidates.push({ draft_id: c.draft_id, name: nm });
  }

  const buildPrompt0 = (retryInfo) =>
    buildDraftEditPrompt(userText, batchLocation, candidates, retryInfo);
  const runEditEngineChain = async (callFn, emptyOutputIsFailure) => {
    const isEmptyFailure = (output) =>
      emptyOutputIsFailure && (typeof output !== "string" || output.trim() === "");
    let output;
    try {
      output = await callFn(buildPrompt0(null));
    } catch (e) {
      return { engineFailed: true };
    }
    if (isEmptyFailure(output)) {
      return { engineFailed: true };
    }
    let result = validateDraftEditOutput(output, candidates);
    if (!result.ok && result.retryable) {
      let retryOutput;
      try {
        retryOutput = await callFn(
          buildPrompt0({ previousOutput: output, reason: result.reason })
        );
      } catch (e) {
        return { engineFailed: true };
      }
      if (isEmptyFailure(retryOutput)) {
        return { engineFailed: true };
      }
      result = validateDraftEditOutput(retryOutput, candidates);
    }
    return { engineFailed: false, result: result };
  };

  let engine = "deepseek";
  let chain;
  if (callLocalLLM) {
    engine = "local";
    chain = await runEditEngineChain(callLocalLLM, true);
    if (chain.engineFailed) {
      engine = "deepseek";
      chain = await runEditEngineChain(callLLM, false);
    }
  } else {
    chain = await runEditEngineChain(callLLM, false);
  }

  if (!chain.engineFailed && chain.result.ok) {
    logger({
      action: "draftEditParse",
      textLength: textLength,
      candidateCount: candidates.length,
      elapsedMs: elapsedMs(),
      engine: engine,
      intent: chain.result.parsed.intent,
    });
    return draftEditResponse(engine, chain.result.parsed);
  }
  logger({
    action: "draftEditParse",
    textLength: textLength,
    candidateCount: candidates.length,
    elapsedMs: elapsedMs(),
    engine: engine,
    intent: null,
    error: "AI_UNAVAILABLE",
  });
  return aiUnavailableResult(engine);
}

// ---------- quantityIntentParse(语音数量意图,Q2,issue #102 / Q0-CONTRACT §7.8) ----------
//
// 零写提议层:对已有物品的数量操作只产出「提议」{intent,item_query,delta|value,
// unit,source_quote,match,needs_pick,ambiguity},绝不写库(本函数无 DB 客户端、
// 无 openid 依赖,结构上不可能写);目标 item_id 必须来自客户端随请求传入的
// 候选清单(客户端经 itemsApi get/query/list 读到的本家庭行,不是数据库事实),
// 由用户在确认页点选——模型绝不能自填 item_id 直改数据库。
// 服务端硬门(不信任模型输出,失败降级绝不猜):
// - 移动句式(拿到/搬到/放到…别的位置)与找回句式(找一下/在哪…)→ intent:"other"
//   (客户端提示一期不支持/走既有查询,移动绝不折算成 subtract);
// - 「还有/大概/差不多」存在「加还是总数」歧义 → unknown + maybe_total,
//   三种数量语义(add/subtract/set)任一都不许静默执行;
// - 数字锚定:delta/value 与 unit 必须能由冻结数字解析器(lib/quantity.js,
//   §7.8.2 唯一数字语义实现)从 source_quote(原话逐字子串,去空白比对)
//   独立解析得到且一致——模型推算(「一箱」折 24)一律降级 unknown;
// - 编造候选(candidate_index 越界/名称对不上)→ 丢弃 match、needs_pick:true;
// - 同名多候选(多位置/多单位)→ needs_pick:true + location_unclear/unit_unclear,
//   弹选择不默认选中由客户端纪律保证;
// - 日志只记 action/textLength/candidateCount/elapsedMs/engine/intent/error,
//   绝不记原文与解析结果。

const QI_TEXT_MAX = 200;
const QI_CANDIDATES_MAX = 12;
const QI_ITEM_ID_MAX = 64;
const QI_NAME_MAX = 50;
const QI_LOCATION_MAX = 200;
const QI_INTENTS = ["add", "subtract", "set", "unknown", "other"];
const QI_QUANTITY_INTENTS = ["add", "subtract", "set"];
// 移动/找回/总数歧义的词表(硬门,覆盖模型判断;「放到」在客户端路由层为保护
// create 句(「剪刀放到书房」)不单独触发数量流,这里仍按 §7.8 列为移动词,
// 仅当句子已经进入数量解析时兜底)
const QI_MOVE_MARKERS = ["拿到", "搬到", "拿去", "挪到", "移到", "移去", "放到"];
const QI_FIND_MARKERS = ["找一下", "找一找", "找找", "在哪里", "在哪儿", "哪儿有", "哪里有", "帮我找"];
const QI_MAYBE_TOTAL_MARKERS = ["还有", "大概", "差不多", "大约"];

const QI_SYSTEM_PROMPT = [
  "你是家庭物品数量的语音意图解析器。用户对着家里已有的物品说了一句话,你只负责解析意图和数量,不负责执行、不回答、不闲聊。",
  "【候选清单】是用户家里可能的目标物品(含当前位置与当前数量)。",
  "规则:",
  '1. intent 只能取:add(在现有数量上增加)/subtract(减少)/set(用户说出了现在的总数)/unknown(分不清是加、减还是总数)/other(不是对已有物品的数量操作:移动位置、找回查询、记新物品、闲聊等)。',
  '2. add 时给 delta(正整数);subtract 时给 delta(负整数);set 时给 value(0-9999 整数);unknown/other 不给数量。',
  '3. 数量必须来自原话里明确说出的「数字+单位」,单位只能是 件/个/包/盒/瓶/袋/支/双/套/卷/张/本/罐/只 之一;source_quote 是原话中承载该数量的逐字子串(如「加两包」里的「两包」)。没说数量、模糊量(几包/一些/半打)、需要换算(一箱=多少包)时,intent 用 unknown,绝不推算。',
  '4. 「还有 N」「大概 N」「差不多 N」说不清是加、减还是当前总数时,intent="unknown" 且 ambiguity="maybe_total",绝不猜成 set、add 或 subtract。',
  '5. 把物品拿到/搬到/放到别的位置(移动)、找一下/在哪里(找回)、买新的/记一件新的(新建)都是 intent="other"。',
  "6. 【候选清单】里名称与用户描述对得上且只有一件时,给 candidate_index(从 0 开始);对不上、同名多件分不清、或清单为空时省略 candidate_index。",
  '只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:',
  '{ "intent": "add", "item_query": "棉柔巾", "delta": 2, "value": null, "unit": "包", "source_quote": "两包", "candidate_index": 0, "ambiguity": null }',
  '字段:item_query 是原话里指代物品的词(不超过 50 字);ambiguity 只能是 maybe_total/location_unclear/unit_unclear 或 null;数字字段给 null 表示没有。',
].join("\n");

function buildQuantityIntentPrompt(userText, candidates, retryInfo) {
  const lines = candidates.map((c, i) => {
    const q = typeof c.quantity === "number" && c.unit ? "当前:" + c.quantity + c.unit : "当前:待核对";
    return "- " + i + ":" + c.name + "(位置:" + (c.location_text || "未归位") + "|" + q + ")";
  });
  let prompt =
    QI_SYSTEM_PROMPT +
    "\n\n【候选清单】\n" +
    (lines.length > 0 ? lines.join("\n") : "(空)") +
    "\n\n" +
    USER_MARKER +
    "\n" +
    userText;
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

/** 候选名称匹配归一(服务端最小口径:trim → 小写 → 删全部空白;不含客户端五级匹配) */
function qiNormalize(s) {
  return String(s === undefined || s === null ? "" : s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function qiContainsMarker(normalizedText, markers) {
  for (const m of markers) {
    if (normalizedText.indexOf(m) !== -1) return true;
  }
  return false;
}

/*
 * 模型输出校验 + 服务端硬门(§7.8,不信任模型输出):
 * 返回 { ok:false, retryable:true, reason }(坏 JSON,handler 带错误重试一次)或
 * { ok:true, parsed }。parsed = { intent, item_query, delta?, value?, unit?,
 * source_quote?, match?, needs_pick, ambiguity? }。
 * 命名匹配/needs_pick/ambiguity 由服务端按候选清单确定性重算:同名多件一律
 * 用户点选(保守方向:绝不自动锁定同名行),单位不清优先于位置不清标注。
 */
function validateQuantityIntentOutput(rawText, normalizedText, candidates) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }

  let intent = typeof parsed.intent === "string" ? parsed.intent : "unknown";
  if (QI_INTENTS.indexOf(intent) === -1) intent = "unknown";

  let itemQuery = typeof parsed.item_query === "string" ? parsed.item_query.trim() : "";
  if (codePointLength(itemQuery) > QI_NAME_MAX) itemQuery = "";

  // 词表硬门(覆盖模型):移动/找回 → other;总数歧义 → unknown + maybe_total
  let ambiguity = null;
  if (qiContainsMarker(normalizedText, QI_MOVE_MARKERS) || qiContainsMarker(normalizedText, QI_FIND_MARKERS)) {
    intent = "other";
  } else if (
    QI_QUANTITY_INTENTS.indexOf(intent) !== -1 &&
    qiContainsMarker(normalizedText, QI_MAYBE_TOTAL_MARKERS)
  ) {
    // §7.8 硬门:三种数量语义(add/subtract/set)任一都不许静默执行——
    // 「还有 N」模型答 subtract 同样落入 unknown + maybe_total(E4 补口)
    intent = "unknown";
    ambiguity = "maybe_total";
  }
  if (intent === "unknown" && parsed.ambiguity === "maybe_total" && ambiguity === null) {
    ambiguity = "maybe_total"; // 模型自报的总数歧义原样透传
  }

  // 数字锚定(仅数量意图):冻结数字解析器从 source_quote 独立解出「数字+单位」,
  // 必须与模型报的 delta/value、unit 完全一致;任一失败整体降级 unknown,绝不采信
  let delta = null;
  let value = null;
  let unit = null;
  let sourceQuote = null;
  if (QI_QUANTITY_INTENTS.indexOf(intent) !== -1) {
    const rawQuote = typeof parsed.source_quote === "string" ? parsed.source_quote : "";
    const quote = stripAllWhitespace(rawQuote);
    let anchored = false;
    let expectedNumber = null;
    if (quote !== "" && codePointLength(quote) <= QI_TEXT_MAX && normalizedText.indexOf(quote) !== -1) {
      const parsedQuote = parseQuantityQuote(quote);
      if (parsedQuote !== null) {
        expectedNumber = parsedQuote.number;
        // 模型报的 unit 也必须逐字等于解析器从 quote 解出的单位(「两包」报盒 → 不采信)
        const modelUnit = parsed.unit;
        const unitAgrees =
          typeof modelUnit === "string" && UNIT_SET.indexOf(modelUnit) !== -1 && modelUnit === parsedQuote.unit;
        if (intent === "set") {
          const v = parsed.value;
          anchored =
            unitAgrees &&
            typeof v === "number" &&
            Number.isInteger(v) &&
            v >= 0 &&
            v <= 9999 &&
            v === expectedNumber;
          if (anchored) value = v;
        } else {
          const d = parsed.delta;
          anchored =
            unitAgrees &&
            typeof d === "number" &&
            Number.isInteger(d) &&
            Math.abs(d) >= 1 &&
            Math.abs(d) <= 9999 &&
            Math.abs(d) === expectedNumber;
          if (anchored) delta = intent === "subtract" ? -Math.abs(d) : Math.abs(d);
        }
        if (anchored) unit = parsedQuote.unit;
      }
    }
    if (!anchored) {
      intent = "unknown";
      ambiguity = null;
    } else {
      sourceQuote = rawQuote.trim();
    }
  }

  // 候选裁定(服务端确定性重算,模型只提议):编造/越界/名称对不上一律丢弃
  let match = null;
  let needsPick = false;
  if (QI_QUANTITY_INTENTS.indexOf(intent) !== -1) {
    const nq = qiNormalize(itemQuery);
    const nameMatches = [];
    candidates.forEach((c, i) => {
      const nc = qiNormalize(c.name);
      if (nq !== "" && nc !== "" && (nc.indexOf(nq) !== -1 || nq.indexOf(nc) !== -1)) {
        nameMatches.push(i);
      }
    });
    // 编造信号:模型给了 candidate_index 但越界,或在界内却与名称匹配对不上
    // (E8/E8b)——即使名称唯一命中,只要模型指认与事实不符就强制用户点选
    let modelIdx = null;
    if (Number.isInteger(parsed.candidate_index) && parsed.candidate_index >= 0 && parsed.candidate_index < candidates.length) {
      modelIdx = parsed.candidate_index;
    }
    const fabricated =
      parsed.candidate_index !== undefined &&
      parsed.candidate_index !== null &&
      (modelIdx === null || nameMatches.indexOf(modelIdx) === -1);
    if (!fabricated && nameMatches.length === 1 && (modelIdx === null || modelIdx === nameMatches[0])) {
      const idx = nameMatches[0];
      match = { candidate_index: idx, matched_word: candidates[idx].name };
      needsPick = false;
    } else {
      // 未命中 / 同名多件 / 模型指认与名称对不上:目标必须由用户点选
      needsPick = true;
      if (nameMatches.length > 1) {
        const units = new Set();
        for (const i of nameMatches) {
          units.add(typeof candidates[i].unit === "string" ? candidates[i].unit : "");
        }
        ambiguity = units.size > 1 ? "unit_unclear" : "location_unclear";
      }
    }
  }

  const out = {
    intent: intent,
    item_query: itemQuery,
    needs_pick: needsPick,
  };
  if (delta !== null) out.delta = delta;
  if (value !== null) out.value = value;
  if (unit !== null) out.unit = unit;
  if (sourceQuote !== null) out.source_quote = sourceQuote;
  if (match !== null) out.match = match;
  if (ambiguity !== null) out.ambiguity = ambiguity;
  return { ok: true, parsed: out };
}

/*
 * quantityIntentParse 入口:event = { action, text, candidates }。
 * 校验(text 去空白 1-200 码点;candidates 0-12 项,item_id ≤64、name 1-50、
 * location_text ≤200、version 正整数、quantity 0-9999 可选、unit ∈ UNIT_SET
 * 闭集可选)失败 → INVALID_INPUT(引擎未参与)。引擎链复用 local→DeepSeek 双引擎降级(与 draftEditParse 同款);
 * 坏 JSON 带错误重试一次仍走同一引擎;双失败/坏输出 → AI_UNAVAILABLE。
 * 日志白名单见上;绝不触任何写。
 */
async function quantityIntentParse(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  const callLocalLLM = deps && typeof deps.callLocalLLM === "function" ? deps.callLocalLLM : null;
  const elapsedMs = () => Date.now() - startedAt;

  const rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logger({ action: "quantityIntentParse", textLength: 0, candidateCount: 0, elapsedMs: elapsedMs(), engine: null, intent: null, error: "INVALID_INPUT" });
    return { ok: false, error: "INVALID_INPUT", message: "数量指令不合法" };
  }
  const userText = rawText.trim();
  const normalizedText = stripAllWhitespace(userText);
  const textLength = codePointLength(normalizedText);
  const failInput = () => {
    logger({ action: "quantityIntentParse", textLength: textLength, candidateCount: 0, elapsedMs: elapsedMs(), engine: null, intent: null, error: "INVALID_INPUT" });
    return { ok: false, error: "INVALID_INPUT", message: "数量指令不合法" };
  };
  if (textLength < 1 || textLength > QI_TEXT_MAX) return failInput();
  if (!Array.isArray(event.candidates) || event.candidates.length > QI_CANDIDATES_MAX) {
    return failInput();
  }
  const candidates = [];
  for (const c of event.candidates) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) return failInput();
    if (typeof c.item_id !== "string" || c.item_id.length < 1 || c.item_id.length > QI_ITEM_ID_MAX) {
      return failInput();
    }
    if (typeof c.name !== "string") return failInput();
    const nm = c.name.trim();
    if (nm === "" || codePointLength(nm) > QI_NAME_MAX) return failInput();
    if (
      typeof c.location_text !== "string" ||
      codePointLength(c.location_text.trim()) > QI_LOCATION_MAX
    ) {
      return failInput();
    }
    if (!Number.isInteger(c.version) || c.version < 1) return failInput();
    // L5/§2.2:候选 unit(展示与 unit_unclear 判定输入)同样必须 ∈ UNIT_SET
    // 闭集逐字成员,缺席/null = 数量未确认;闭集外字符串一律 INVALID_INPUT
    // (引擎未参与),不随候选进入提示词与歧义判定。
    let unit = null;
    if (c.unit !== undefined && c.unit !== null) {
      if (typeof c.unit !== "string" || UNIT_SET.indexOf(c.unit) === -1) {
        return failInput();
      }
      unit = c.unit;
    }
    candidates.push({
      item_id: c.item_id,
      name: nm,
      location_text: c.location_text.trim(),
      quantity: Number.isInteger(c.quantity) && c.quantity >= 0 && c.quantity <= 9999 ? c.quantity : null,
      unit: unit,
      version: c.version,
    });
  }
  const candidateCount = candidates.length;

  const buildPrompt0 = (retryInfo) => buildQuantityIntentPrompt(userText, candidates, retryInfo);
  const runChain = async (callFn, emptyOutputIsFailure) => {
    const isEmptyFailure = (output) =>
      emptyOutputIsFailure && (typeof output !== "string" || output.trim() === "");
    let output;
    try {
      output = await callFn(buildPrompt0(null));
    } catch (e) {
      return { engineFailed: true };
    }
    if (isEmptyFailure(output)) {
      return { engineFailed: true };
    }
    let result = validateQuantityIntentOutput(output, normalizedText, candidates);
    if (!result.ok && result.retryable) {
      let retryOutput;
      try {
        retryOutput = await callFn(
          buildPrompt0({ previousOutput: output, reason: result.reason }),
        );
      } catch (e) {
        return { engineFailed: true };
      }
      if (isEmptyFailure(retryOutput)) {
        return { engineFailed: true };
      }
      result = validateQuantityIntentOutput(retryOutput, normalizedText, candidates);
    }
    return { engineFailed: false, result: result };
  };

  let engine = "deepseek";
  let chain;
  if (callLocalLLM) {
    engine = "local";
    chain = await runChain(callLocalLLM, true);
    if (chain.engineFailed) {
      engine = "deepseek";
      chain = await runChain(callLLM, false);
    }
  } else {
    chain = await runChain(callLLM, false);
  }

  if (!chain.engineFailed && chain.result.ok) {
    logger({
      action: "quantityIntentParse",
      textLength: textLength,
      candidateCount: candidateCount,
      elapsedMs: elapsedMs(),
      engine: engine,
      intent: chain.result.parsed.intent,
    });
    return Object.assign({ ok: true, engine: engine }, chain.result.parsed);
  }
  logger({
    action: "quantityIntentParse",
    textLength: textLength,
    candidateCount: candidateCount,
    elapsedMs: elapsedMs(),
    engine: engine,
    intent: null,
    error: "AI_UNAVAILABLE",
  });
  return aiUnavailableResult(engine);
}

// ---------- locationSplit(位置层级拆分,§1.6 真机 2026-10-17) ----------
//
// 无分隔符中文(「书房桌子右边抽屉」)用 splitLocationSegments 的分隔符规则
// 只能整串挂一个平节点;中文无分隔符不可能用规则确定性拆分——交给模型按
// 「从大到小」拆层级,纪律与语音链路 mount_path 同源:每段必须是原文逐字
// 子串(可跳过连接字/空白,不得改写、缩写、编造),服务端硬校验不信任模型。

const LOC_SPLIT_TEXT_MAX = 200;
const LOC_SPLIT_MAX_SEGMENTS = 6;
const LOC_SPLIT_SEGMENT_MAX = 30;
/** 位置原文标记(与【用户输入】同族,拼装方式参照 buildDraftEditPrompt) */
const SOURCE_MARKER = "【原文】";

const LOCATION_SPLIT_SYSTEM_PROMPT = [
  "你是家庭位置层级拆分器。用户给一段位置描述,把它拆成从大到小的层级路径。",
  "规则:",
  "1. 每一段必须逐字取自原文(可跳过连接字/空白,但不得改写、缩写、编造)。",
  "2. 「的」「了」是连接字,绝不出现在任何段内:它前后的实体要拆开成各自独立的段。",
  "3. 纯方位词(右边/左边/上面/下面/里面/中间等)不能单独成段,它一律修饰**后一个**实体:输出「中间抽屉」「右边抽屉」,绝不把方位词并入前面的实体(不要输出「桌子中间」);但「第二层」「上层」这类本身就是层格实体的可以独立成段。",
  "4. 最多 6 段,每段 1-30 字。",
  "5. 拆不出层级(单实体)就输出单段整串。",
  "例子:「书房桌子的右边抽屉」→ [\"书房\",\"桌子\",\"右边抽屉\"];「书房桌子中间抽屉」→ [\"书房\",\"桌子\",\"中间抽屉\"];「厨房冰箱第二层」→ [\"厨房\",\"冰箱\",\"第二层\"];「玄关柜」→ [\"玄关柜\"]。",
  '6. 只输出一个 JSON 对象 {"path":["…"]},不要任何其他文字或围栏。',
].join("\n");

function locationSplitInvalidInputResult() {
  return { ok: false, error: "INVALID_INPUT", message: "位置描述不合法" };
}

function buildLocationSplitPrompt(userText, retryInfo) {
  let prompt = LOCATION_SPLIT_SYSTEM_PROMPT + "\n\n" + SOURCE_MARKER + "\n" + userText;
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

/*
 * 模型输出校验 + 服务端硬门(不信任模型):
 * - 顶层不是 JSON 对象 / path 缺失或不是数组 → retryable(handler 带错误重试一次);
 * - 段级硬门(不过 = fallback,不重试):1-6 段、每段 trim 后 1-30 码点、
 *   每段是原文逐字子串且按原文顺序出现(有序锚定:后一段必须在前一段结束
 *   之后的位置找到)——任一不过 → 整串单段兜底 {path:[text],fallback:true},
 *   绝不带模型改写/编造的段上树。
 */
function validateLocationSplitOutput(rawText, userText) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (!Array.isArray(parsed.path)) {
    return { ok: false, retryable: true, reason: "path 字段缺失或不是数组" };
  }
  const fallback = () => ({ ok: true, fallback: true, segments: null });
  if (parsed.path.length < 1 || parsed.path.length > LOC_SPLIT_MAX_SEGMENTS) {
    return fallback();
  }
  const segments = [];
  for (const seg of parsed.path) {
    if (typeof seg !== "string") return fallback();
    const t = seg.trim();
    if (codePointLength(t) < 1 || codePointLength(t) > LOC_SPLIT_SEGMENT_MAX) {
      return fallback();
    }
    segments.push(t);
  }
  // 方位词修补(真机 2026-10-18 复现:模型把「右边」单独成段):纯方位定语段
  // 与相邻段确定性合并——优先并入后段(右边+抽屉→右边抽屉),后段不可行再并前段;
  // 合并结果仍须逐字锚定(拼接恰为原文连续子串),否则维持原判走 fallback。
  const DIR_WORDS = ["上", "下", "左", "右", "左边", "右边", "上面", "下面", "上边", "下边",
    "里面", "里边", "中间", "旁边", "附近", "上方", "下方", "里", "内", "中"];
  // 段尾方位词前移(真机 2026-10-18 二次:「书房桌子中间抽屉」被拆成 桌子中间|抽屉):
  // 非末段以方位词结尾且(方位词+后段)为原文连续子串 → 拆出前移(桌子中间|抽屉→桌子|中间抽屉);
  // 末段的段尾方位词保留(「书房桌子中间」=桌上中部,真语义);不锚定则不动,交由整体锚定门裁决。
  const forward = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    if (next === undefined || DIR_WORDS.indexOf(seg) !== -1) {
      forward.push(seg);
      continue;
    }
    let moved = false;
    for (const dw of DIR_WORDS) {
      if (seg.length > dw.length && seg.slice(-dw.length) === dw) {
        const head = seg.slice(0, -dw.length);
        if (userText.indexOf(dw + next) !== -1 && userText.indexOf(head) !== -1) {
          forward.push(head);
          segments[i + 1] = dw + next;
          moved = true;
        }
        break;
      }
    }
    if (!moved) {
      forward.push(seg);
    }
  }
  const repaired = [];
  for (let i = 0; i < forward.length; i++) {
    const seg = forward[i];
    if (DIR_WORDS.indexOf(seg) === -1) {
      repaired.push(seg);
      continue;
    }
    const next = forward[i + 1];
    if (next !== undefined && userText.indexOf(seg + next) !== -1) {
      repaired.push(seg + next);
      i += 1;
      continue;
    }
    const prev = repaired[repaired.length - 1];
    if (prev !== undefined && userText.indexOf(prev + seg) !== -1) {
      repaired[repaired.length - 1] = prev + seg;
      continue;
    }
    return fallback();
  }
  if (repaired.some((seg) => codePointLength(seg) > LOC_SPLIT_SEGMENT_MAX)) {
    return fallback();
  }
  let searchFrom = 0;
  for (const seg of repaired) {
    const idx = userText.indexOf(seg, searchFrom);
    if (idx === -1) return fallback();
    searchFrom = idx + seg.length;
  }
  return { ok: true, segments: repaired };
}

/*
 * locationSplit 入口(event = {action:"locationSplit", text}):无状态纯解析,
 * 无 DB 客户端、无 openid 依赖(结构上不可能写)。
 * - text 去空白 1-200 码点,非法 → INVALID_INPUT(引擎未参与);
 * - 引擎链与 draftEditParse 完全同款:local 优先(emptyOutputIsFailure:空文本
 *   视为引擎失败)→ 失败立即降级 DeepSeek;坏 JSON 带错误重试一次仍走同一
 *   引擎(模型质量失败不触发降级);双失败/两次坏 JSON → AI_UNAVAILABLE
 *   (客户端走 splitLocationSegments 确定性兜底);
 * - 段级硬门不过 → ok:true + path:[整串] + fallback:true(单段兜底,不失败);
 * - 日志只记 {action, textLength, segCount, engine, error?}(白名单),绝不落
 *   位置原文与拆分结果。
 */
async function locationSplit(event, deps) {
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const callLLM = deps ? deps.callLLM : undefined;
  const callLocalLLM =
    deps && typeof deps.callLocalLLM === "function" ? deps.callLocalLLM : null;

  const rawText = event && typeof event.text === "string" ? event.text : null;
  if (rawText === null) {
    logger({ action: "locationSplit", textLength: 0, segCount: 0, engine: null, error: "INVALID_INPUT" });
    return locationSplitInvalidInputResult();
  }
  const textLength = codePointLength(stripAllWhitespace(rawText));
  const userText = rawText.trim();
  if (textLength < 1 || textLength > LOC_SPLIT_TEXT_MAX) {
    logger({ action: "locationSplit", textLength: textLength, segCount: 0, engine: null, error: "INVALID_INPUT" });
    return locationSplitInvalidInputResult();
  }

  const buildPrompt0 = (retryInfo) => buildLocationSplitPrompt(userText, retryInfo);
  const runSplitEngineChain = async (callFn, emptyOutputIsFailure) => {
    const isEmptyFailure = (output) =>
      emptyOutputIsFailure && (typeof output !== "string" || output.trim() === "");
    let output;
    try {
      output = await callFn(buildPrompt0(null));
    } catch (e) {
      return { engineFailed: true };
    }
    if (isEmptyFailure(output)) {
      return { engineFailed: true };
    }
    let result = validateLocationSplitOutput(output, userText);
    if (!result.ok && result.retryable) {
      let retryOutput;
      try {
        retryOutput = await callFn(
          buildPrompt0({ previousOutput: output, reason: result.reason })
        );
      } catch (e) {
        return { engineFailed: true };
      }
      if (isEmptyFailure(retryOutput)) {
        return { engineFailed: true };
      }
      result = validateLocationSplitOutput(retryOutput, userText);
    }
    return { engineFailed: false, result: result };
  };

  let engine = "deepseek";
  let chain;
  if (callLocalLLM) {
    engine = "local";
    chain = await runSplitEngineChain(callLocalLLM, true);
    if (chain.engineFailed) {
      engine = "deepseek";
      chain = await runSplitEngineChain(callLLM, false);
    }
  } else {
    chain = await runSplitEngineChain(callLLM, false);
  }

  if (!chain.engineFailed && chain.result.ok) {
    if (chain.result.fallback) {
      // 段级硬门不过:整串单段兜底(挂平节点,绝不带编造段)
      logger({ action: "locationSplit", textLength: textLength, segCount: 1, engine: engine });
      return { ok: true, engine: engine, path: [userText], fallback: true };
    }
    logger({
      action: "locationSplit",
      textLength: textLength,
      segCount: chain.result.segments.length,
      engine: engine,
    });
    return { ok: true, engine: engine, path: chain.result.segments, fallback: false };
  }
  logger({
    action: "locationSplit",
    textLength: textLength,
    segCount: 0,
    engine: engine,
    error: "AI_UNAVAILABLE",
  });
  return aiUnavailableResult(engine);
}

// ---------- videoTargetRecognize(单帧“AI 找这件物品”,无状态只走 VL) ----------

const VIDEO_TARGET_NAME_MAX = 40;
const VIDEO_TARGET_CONFIDENCES = ["high", "mid", "low"];

const VIDEO_TARGET_SYSTEM_PROMPT = [
  "你是家庭视频单帧目标物品定位器。用户会给出一个目标物品名称与一帧视频画面,请判断目标是否出现在这一帧。",
  "规则:",
  "1. found 为布尔值:画面里能明确看到目标就为 true,看不到或无法确认就为 false。",
  "2. confidence 只能是 high、mid、low 之一。",
  "3. box 为 [x1,y1,x2,y2] 四个 0-1000 的整数,归一化到图片宽高,(0,0) 在左上角,x1<x2、y1<y2。found 为 false 时 box 为 null;看不清时 confidence 给 low。",
  "4. 只输出一个 JSON 对象,不要输出任何其他文字、解释或代码块围栏。形状:",
  '{ "found": true, "confidence": "high", "box": [x1,y1,x2,y2] }',
].join("\n");

function buildVideoTargetPrompt(targetName, retryInfo) {
  let prompt = VIDEO_TARGET_SYSTEM_PROMPT + "\n\n【目标物品】\n" + targetName;
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

/*
 * 严格校验模型形状:
 * - 顶层不是 JSON 对象/found 非布尔/confidence 词表外 → retryable(带错误重试一次);
 * - found=false → hit:false,box:null;
 * - found=true 但 box 不是合法 0-1000 整数框 → hit:false,box:null
 *   (不产生可确认候选,绝不按值域猜量纲/钳制);
 * - 仅合法框经 normalizeVlBox 归一为 0-1。
 */
function validateVideoTargetOutput(rawText) {
  const parsed = extractJsonObject(rawText);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, retryable: true, reason: "输出不是合法的 JSON 对象" };
  }
  if (typeof parsed.found !== "boolean") {
    return { ok: false, retryable: true, reason: "found 字段缺失或不是布尔值" };
  }
  if (VIDEO_TARGET_CONFIDENCES.indexOf(parsed.confidence) === -1) {
    return { ok: false, retryable: true, reason: "confidence 字段不在词表内" };
  }
  if (parsed.found === false) {
    return { ok: true, hit: false, box: null, confidence: parsed.confidence };
  }
  const box = normalizeVlBox(parsed.box);
  if (box === null) {
    return { ok: true, hit: false, box: null, confidence: parsed.confidence };
  }
  return { ok: true, hit: true, box: box, confidence: parsed.confidence };
}

function videoTargetInvalidInputResult() {
  return {
    ok: false,
    error: "INVALID_INPUT",
    message: "这一帧图片或目标参数不符合识别要求,请重试",
  };
}

function videoTargetUnavailableResult() {
  return {
    ok: false,
    error: "AI_UNAVAILABLE",
    message: "AI 查找暂不可用,可继续回放视频自己确认",
    manual_fallback: true,
  };
}

/*
 * videoTargetRecognize:
 * - 输入门:target_name trim 后 1..40 码点;裸 base64 1..4,000,000 字符且可解码;
 *   img_w/img_h 整数 1..10000;任一不过 → INVALID_INPUT,零调用、零落库;
 * - 只走现有 VL 三件套;未注入 callVL(未配置)→ AI_UNAVAILABLE + manual_fallback;
 * - 模型输出坏 JSON/形状失败 → 带错误重试一次,仍败或引擎抛错 → AI_UNAVAILABLE;
 * - 日志白名单:action/elapsedMs/engine/hit/targetLen/error/reason,绝不记
 *   target_name、base64、prompt 或模型原文。
 */
async function videoTargetRecognize(event, deps) {
  const startedAt = Date.now();
  const logger = deps && typeof deps.logger === "function" ? deps.logger : function () {};
  const elapsedMs = () => Date.now() - startedAt;
  const rawTarget = event && typeof event.target_name === "string" ? event.target_name : null;
  const targetName = rawTarget === null ? "" : rawTarget.trim();
  const targetLen = codePointLength(targetName);

  const invalid = () => {
    logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, error: "INVALID_INPUT" });
    return videoTargetInvalidInputResult();
  };

  if (targetLen < 1 || targetLen > VIDEO_TARGET_NAME_MAX) {
    return invalid();
  }
  const imageBase64 = event && typeof event.image_base64 === "string" ? event.image_base64 : null;
  if (
    imageBase64 === null ||
    imageBase64.length < 1 ||
    imageBase64.length > VL_MAX_IMAGE_BASE64_CHARS ||
    VL_BASE64_RE.test(imageBase64) === false
  ) {
    return invalid();
  }
  const imgW = event ? event.img_w : undefined;
  if (Number.isInteger(imgW) === false || imgW < 1 || imgW > VL_IMG_DIM_MAX) {
    return invalid();
  }
  const imgH = event ? event.img_h : undefined;
  if (Number.isInteger(imgH) === false || imgH < 1 || imgH > VL_IMG_DIM_MAX) {
    return invalid();
  }
  if (Buffer.byteLength(imageBase64, "base64") < 1) {
    return invalid();
  }

  const callVL = deps && typeof deps.callVL === "function" ? deps.callVL : null;
  if (callVL === null) {
    logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, error: "AI_UNAVAILABLE", reason: "vl_not_configured" });
    return videoTargetUnavailableResult();
  }

  let output;
  try {
    output = await callVL(buildVideoTargetPrompt(targetName, null), imageBase64);
  } catch (e) {
    logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, error: "AI_UNAVAILABLE", reason: "vl_call_failed" });
    return videoTargetUnavailableResult();
  }
  let result = validateVideoTargetOutput(output);
  if (result.ok === false && result.retryable === true) {
    let retryOutput;
    try {
      retryOutput = await callVL(
        buildVideoTargetPrompt(targetName, { previousOutput: output, reason: result.reason }),
        imageBase64
      );
    } catch (e) {
      logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, error: "AI_UNAVAILABLE", reason: "vl_call_failed" });
      return videoTargetUnavailableResult();
    }
    result = validateVideoTargetOutput(retryOutput);
    if (result.ok === false) {
      logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, error: "AI_UNAVAILABLE", reason: "vl_bad_output" });
      return videoTargetUnavailableResult();
    }
  }

  logger({ action: "videoTargetRecognize", elapsedMs: elapsedMs(), engine: "vl-local", targetLen: targetLen, hit: result.hit });
  return { ok: true, hit: result.hit, box: result.box, confidence: result.confidence };
}

module.exports = {
  handler,
  buildPrompt,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_V2,
  vlRecognize,
  draftEditParse,
  buildVlPrompt,
  validateVlOutput,
  validateDraftEditOutput,
  quantityIntentParse,
  buildQuantityIntentPrompt,
  validateQuantityIntentOutput,
  QI_SYSTEM_PROMPT,
  locationSplit,
  videoTargetRecognize,
  buildVideoTargetPrompt,
  validateVideoTargetOutput,
  LOCATION_SPLIT_SYSTEM_PROMPT,
  buildLocationSplitPrompt,
  validateLocationSplitOutput,
};
