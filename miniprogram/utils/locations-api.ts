/**
 * locations 云函数调用封装(类型化,issue #18 空间树):
 * - 统一 wx.cloud.callFunction 调用与超时控制(超时严格大于服务端对应预算,
 *   优先让服务端错误先于客户端到点返回,照 utils/api.ts 的放宽原则);
 * - 服务端错误码映射为可直接展示的中文文案(服务端 message 缺失时兜底),
 *   NODE_NOT_EMPTY/NODE_CONFLICT/merge 冲突等业务错误附带的 detail 结构化保留;
 * - 对 ok:true 响应做最小结构校验,结构不符按异常响应处理(如实提示);
 * - 写类 action 自动拼装作用域一致性绑定(issue #34 P1-B,F2 客户端半边):
 *   expected_household_id / expected_scope_revision 取自服务端 list/status
 *   响应捕获的权威作用域,仅作一致性前置条件、绝不授权;未捕获时不编造。
 *
 * 本模块不读取、不传输任何身份字段;openid 一律由服务端派生,
 * household_id 相关字段只是服务端解析结果的回显(一致性校验用,不具授权效力)。
 */
import {
  ApiError,
  CLIENT_BAD_RESPONSE,
  CLIENT_NETWORK,
  CLIENT_TIMEOUT,
} from "./api";
import { clearLocationsCache } from "./locations-cache";
import {
  captureHouseholdId,
  scopeWriteMarkers,
} from "./household-scope";
import { notifyFamilyScopeDrift } from "./households-api";
import type {
  ApplyScanResponse,
  DeleteLocationResponse,
  EnsureAndLinkResponse,
  EnsurePathResponse,
  LinkItemResponse,
  ListLocationsResponse,
  LocationsApiEvent,
  LocationsApiOkResponse,
  MergeLocationResponse,
  MoveLocationResponse,
  ParseLocationResponse,
  RenameLocationResponse,
  ScanHouseholdResponse,
} from "../types";

const LOCATIONS_API_FUNCTION = "locations";

/** db 类 action 为薄操作,正常应在数秒内返回 */
const LOCATIONS_DB_TIMEOUT_MS = 15000;
/** parseLocation 服务端单块 LLM 预算 15s×2(重试),客户端放宽到 30s */
const LOCATIONS_PARSE_TIMEOUT_MS = 30000;
/**
 * scanHousehold 服务端最坏 ~50s(3 块并行 + 近义串行)、applyScan 最坏 ~100 次
 * DB 往返,均在函数 60s 上限内;客户端放宽到 70s,严格大于服务端上限。
 */
const LOCATIONS_SCAN_TIMEOUT_MS = 70000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 携带 locations 协议 detail 的异常(NODE_NOT_EMPTY 计数、merge 冲突清单等) */
export class LocationsApiError extends ApiError {
  /** 服务端 ok:false 附带的结构化补充(只出现在响应,绝不进日志) */
  readonly detail?: Record<string, unknown>;

  constructor(code: string, message: string, detail?: unknown) {
    super(code, message);
    this.name = "LocationsApiError";
    if (isRecord(detail)) {
      this.detail = detail;
    }
  }
}

/** 服务端错误码 → 默认中文文案(服务端 message 缺失时兜底) */
const LOCATIONS_API_MESSAGES: Record<string, string> = {
  INVALID_INPUT: "输入不合法,请检查后重试",
  NOT_FOUND: "没有找到这个位置",
  UNAUTHORIZED: "登录状态异常,请退出小程序后重试",
  VERSION_CONFLICT: "物品内容已被修改,已为你刷新,请重试",
  NODE_NOT_EMPTY: "这里还有东西,先移走物品和子位置才能删除",
  NODE_CONFLICT: "目标位置已有同名节点,或不能移动到自己下面",
  AI_UNAVAILABLE: "AI 暂时不可用,可稍后重试或手动选择位置",
  FAMILY_SWITCHED: "家庭已切换,本次操作未保存,请确认当前家庭后重试",
  FAMILY_STALE_SCOPE: "家庭刚发生成员或作用域变化,本次操作未保存,请刷新后重试",
  HOUSEHOLD_UNAVAILABLE: "暂时无法确认当前家庭,请稍后重试",
};

const BAD_RESPONSE_MESSAGE = "服务返回异常,请稍后重试";
const DEFAULT_ERROR_MESSAGE = "服务暂时不可用,请稍后重试";

/** 把服务端 ok:false 体转换为 LocationsApiError;优先使用服务端中文 message */
function toLocationsServerError(
  code: unknown,
  message: unknown,
  detail?: unknown,
): LocationsApiError {
  const codeText =
    typeof code === "string" && code.length > 0 ? code : CLIENT_BAD_RESPONSE;
  const fallback = LOCATIONS_API_MESSAGES[codeText];
  const serverMessage =
    typeof message === "string" && message.trim().length > 0 ? message : "";
  return new LocationsApiError(
    codeText,
    serverMessage || fallback || DEFAULT_ERROR_MESSAGE,
    detail,
  );
}

/** 调用云函数,带客户端超时;不静默吞错,失败一律 reject */
function callCloudFunction(
  name: string,
  data: unknown,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) {
      reject(
        new ApiError(
          CLIENT_NETWORK,
          "当前微信版本过低,无法使用云能力,请升级微信后重试",
        ),
      );
      return;
    }
    let done = false;
    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      reject(new ApiError(CLIENT_TIMEOUT, "请求超时,请检查网络后重试"));
    }, timeoutMs);
    wx.cloud.callFunction({
      name,
      data: data as WechatMiniprogram.IAnyObject,
      success: (res) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve((res as { result?: unknown }).result);
      },
      fail: (err) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        console.error("[locations-api] 云函数调用失败:", name, err && err.errMsg);
        reject(new ApiError(CLIENT_NETWORK, "网络异常,请稍后重试"));
      },
    });
  });
}

function isLocationNodeSummary(v: unknown): boolean {
  return (
    isRecord(v) &&
    typeof v.location_id === "string" &&
    typeof v.name === "string" &&
    typeof v.type === "string" &&
    Array.isArray(v.path)
  );
}

/** 对 ok:true 响应做最小结构校验,结构不符按异常响应处理(如实提示) */
function validateLocationsOkResponse(
  action: string,
  r: Record<string, unknown>,
): void {
  const bad = () => new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  switch (action) {
    case "list":
      if (
        !isLocationNodeSummary(r.node) ||
        !Array.isArray(r.children) ||
        !Array.isArray(r.items) ||
        typeof r.unmounted_count !== "number" ||
        typeof r.dangling_mounts !== "number"
      ) {
        throw bad();
      }
      break;
    case "ensurePath":
      if (!Array.isArray(r.nodes) || !Array.isArray(r.created)) {
        throw bad();
      }
      break;
    case "rename":
    case "move":
    case "merge":
      if (!isLocationNodeSummary(r.node)) {
        throw bad();
      }
      break;
    case "delete":
      if (typeof r.deleted_nodes !== "number") {
        throw bad();
      }
      break;
    case "linkItem":
    case "unlinkItem":
      if (!isRecord(r.item) || typeof r.item.version !== "number") {
        throw bad();
      }
      break;
    case "ensureAndLink":
      // 十七轮「放进」:already/item.version/path/created/location_ids 逐项校验,
      // 结构不符按异常响应处理(挂靠是否成功绝不含糊)
      if (
        typeof r.already !== "boolean" ||
        !isRecord(r.item) ||
        typeof r.item.version !== "number" ||
        !Array.isArray(r.path) ||
        !Array.isArray(r.created) ||
        !Array.isArray(r.location_ids)
      ) {
        throw bad();
      }
      break;
    case "parseLocation":
      if (
        !isRecord(r.parse) ||
        !Array.isArray(r.parse.segments) ||
        typeof r.parse.need_confirm !== "boolean"
      ) {
        throw bad();
      }
      break;
    case "scanHousehold":
      if (
        !isRecord(r.scan) ||
        !Array.isArray(r.scan.candidate_tree) ||
        !Array.isArray(r.scan.mounts) ||
        !Array.isArray(r.scan.skipped) ||
        typeof r.scan.unmounted_total !== "number"
      ) {
        throw bad();
      }
      break;
    case "applyScan":
      if (
        !isRecord(r.result) ||
        !Array.isArray(r.result.branches) ||
        !Array.isArray(r.result.mounts)
      ) {
        throw bad();
      }
      break;
    default:
      break;
  }
}

function timeoutForAction(action: string): number {
  if (action === "parseLocation") {
    return LOCATIONS_PARSE_TIMEOUT_MS;
  }
  if (action === "scanHousehold" || action === "applyScan") {
    return LOCATIONS_SCAN_TIMEOUT_MS;
  }
  return LOCATIONS_DB_TIMEOUT_MS;
}

/**
 * 会改变空间树或挂载关系的 action:成功后整棵树缓存失效(issue #23,第一版
 * 全量失效,不做节点级精细化)。list/parseLocation/scanHousehold 只读,不清。
 */
const LOCATIONS_MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  "ensurePath",
  "rename",
  "move",
  "merge",
  "delete",
  "linkItem",
  "unlinkItem",
  "applyScan",
  "ensureAndLink",
]);

export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "list" }>,
): Promise<ListLocationsResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "ensurePath" }>,
): Promise<EnsurePathResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "rename" }>,
): Promise<RenameLocationResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "move" }>,
): Promise<MoveLocationResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "merge" }>,
): Promise<MergeLocationResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "delete" }>,
): Promise<DeleteLocationResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "linkItem" }>,
): Promise<LinkItemResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "unlinkItem" }>,
): Promise<LinkItemResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "ensureAndLink" }>,
): Promise<EnsureAndLinkResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "parseLocation" }>,
): Promise<ParseLocationResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "scanHousehold" }>,
): Promise<ScanHouseholdResponse>;
export function callLocationsApi(
  event: Extract<LocationsApiEvent, { action: "applyScan" }>,
): Promise<ApplyScanResponse>;
export async function callLocationsApi(
  event: LocationsApiEvent,
): Promise<LocationsApiOkResponse> {
  // F2 客户端半边(issue #34 P1-B):写类 action 自动附
  // expected_household_id / expected_scope_revision(来自 household-scope 捕获的
  // 服务端权威作用域;未捕获时不编造,旧云函数窗口与 0.4.7 单人行为逐字节一致)
  const payload: unknown = LOCATIONS_MUTATING_ACTIONS.has(event.action)
    ? { ...event, ...scopeWriteMarkers() }
    : event;
  let result: unknown;
  try {
    result = await callCloudFunction(
      LOCATIONS_API_FUNCTION,
      payload,
      timeoutForAction(event.action),
    );
  } catch (e) {
    // FAMILY_SWITCHED / FAMILY_STALE_SCOPE:家庭状态刚变化——触发 status 刷新
    // 作用域,绝不静默重试,由用户按服务端文案重试
    notifyFamilyScopeDrift(e);
    throw e;
  }
  if (!isRecord(result)) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  if (result.ok === false) {
    const err = toLocationsServerError(result.error, result.message, result.detail);
    notifyFamilyScopeDrift(err);
    throw err;
  }
  if (result.ok !== true) {
    throw new ApiError(CLIENT_BAD_RESPONSE, BAD_RESPONSE_MESSAGE);
  }
  validateLocationsOkResponse(event.action, result);
  if (event.action === "list") {
    // issue #34 P0/P1-B:从 list 响应捕获服务端解析的家庭作用域(household_id
    // 必带;共享家庭另带 scope_revision)。捕获到作用域切换时清整树缓存,
    // 把家庭切换显式接入既有失效代数(F2);非法/缺省静默忽略,保持回退值
    if (captureHouseholdId(result.household_id, result.scope_revision)) {
      clearLocationsCache();
    }
  }
  if (LOCATIONS_MUTATING_ACTIONS.has(event.action)) {
    // 失效收口在 API 层:变更成功即整树失效,页面不自己记「该清哪层」
    clearLocationsCache();
  }
  return result as unknown as LocationsApiOkResponse;
}

/** locations 协议错误码判断(用于分支处理,如 AI_UNAVAILABLE 的手动兜底) */
export function isLocationsApiErrorWithCode(
  e: unknown,
  code: string,
): e is LocationsApiError {
  return e instanceof LocationsApiError && e.code === code;
}
