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
};
