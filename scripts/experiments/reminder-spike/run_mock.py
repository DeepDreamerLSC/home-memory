#!/usr/bin/env python3
"""reminder-spike 离线 mock 评测(issue #36 D1b,零 key、零网络、零第三方依赖)。

管线(与未来真实评测同构,只是把 LLM 换成固定 mock 响应):
  mock-responses.jsonl(逐句固定响应,含 6 处人为注入的偏差)
    → extract_json_object(容忍围栏/前后废话,同 cloudfunctions/extractDraft/lib/validate.js 口径)
    → validate_item(结构校验 + 日期纪律硬规则 R1-R8,违规自动保守修正)
    → deep_diff(与 corpus.jsonl 金标逐字段比对)
    → outputs/report.json + outputs/report.md + stdout 摘要

本脚本证明评测框架可跑、三层检测(解析失败/纪律违规/金标差异)都能命中;
真实 LLM 跑批是 TODO,须另立实验授权,不在本批。
退出码:0 = 注入偏差全部被检出且干净句零差异;1 = 有漏检或误报。
"""

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_PATH = os.path.join(HERE, "corpus.jsonl")
MOCK_PATH = os.path.join(HERE, "mock-responses.jsonl")
PROMPT_PATH = os.path.join(HERE, "prompt-draft.txt")
OUT_DIR = os.path.join(HERE, "outputs")

# 与金标计算口径一致(#36 D1b 冻结日);真实运行时应改为运行日并重算金标。
REFERENCE_DATE = "2026-10-13"

TASK_KINDS = {"replace", "clean", "warranty", "return", "consume", "expiry", "other", "none"}
TIME_TYPES = {
    "absolute_date", "relative_weekday", "relative_period", "recurring_period",
    "after_open", "production_shelf_life", "vague", "none",
}
UNITS = {"day", "week", "month", "year"}
BASES = {"record_date", "completion_date", "open_date", "open_date_unstated", "production_date", None}
REASONS = {
    "EXPLICIT_DATE", "RELATIVE_BASE_MUST_CONFIRM", "WEEKDAY_AMBIGUOUS",
    "AFTER_OPEN_BASE_UNKNOWN", "OPEN_DATE_BASE_MUST_CONFIRM", "PRODUCTION_CONVERSION",
    "MONTH_PRECISION", "VAGUE_EXPRESSION", "NO_TIME_STATED", "MEDICAL_EXCLUDED_ROUND1", "NO_TASK",
}
NEED_CONFIRM_TYPES = {
    "relative_period", "recurring_period", "relative_weekday", "after_open",
    "production_shelf_life", "vague",
}

# 人为注入的偏差清单(证明检出能力用,不代表任何真实模型表现)
INJECTED = {
    "c01": "hallucinated_location",   # 位置幻觉:输出原文没有的「厨房橱柜」
    "c07": "need_confirm_violation",  # 星期换算未要求确认
    "c13": "wrong_open_base_date",    # 开封基准日算错(用录入日代替开封日)
    "c27": "silent_guess_on_vague",   # 模糊表达被静默折算成日期
    "c30": "medical_not_excluded",    # 医疗类未排除
    "c34": "malformed_json",          # 响应不是 JSON
}

NAME_MAX, LOC_MAX, QUOTE_MAX, RAW_MAX = 50, 200, 200, 50
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def norm(s):
    return re.sub(r"\s+", "", s or "")


def cp_len(s):
    return len(s or "")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit("%s 第 %d 行不是合法 JSONL:%s" % (path, lineno, e))
    return rows


def extract_json_object(raw):
    """与 validate.js 同口径:整体解析失败则截取首 { 到末 } 再试。"""
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    try:
        return json.loads(trimmed)
    except ValueError:
        pass
    first, last = trimmed.find("{"), trimmed.rfind("}")
    if first == -1 or last <= first:
        return None
    try:
        return json.loads(trimmed[first:last + 1])
    except ValueError:
        return None


def validate_item(item, text):
    """结构校验 + 日期纪律硬规则。返回 (修正后的 item, 违规码列表)。"""
    v = []
    out = dict(item)

    def bad(code):
        v.append(code)

    # ---- 结构 ----
    if not isinstance(out.get("item_name"), str) or not norm(out.get("item_name")) or cp_len(out["item_name"]) > NAME_MAX:
        bad("STRUCT_ITEM_NAME")
    if not isinstance(out.get("location_text"), str) or cp_len(out["location_text"]) > LOC_MAX:
        bad("STRUCT_LOCATION")
    if not isinstance(out.get("location_certain"), bool):
        bad("STRUCT_LOCATION_CERTAIN")
    task = out.get("task") or {}
    if task.get("kind") not in TASK_KINDS or not isinstance(task.get("raw"), str) or cp_len(task.get("raw")) > RAW_MAX:
        bad("STRUCT_TASK")
    t = out.get("time") or {}
    if t.get("type") not in TIME_TYPES or not isinstance(t.get("raw"), str) or cp_len(t.get("raw")) > RAW_MAX:
        bad("STRUCT_TIME")
    if t.get("period_unit") is not None and t.get("period_unit") not in UNITS:
        bad("STRUCT_PERIOD_UNIT")
    if t.get("base") not in BASES:
        bad("STRUCT_BASE")
    if t.get("production_date") is not None and not (isinstance(t.get("production_date"), str) and DATE_RE.match(t["production_date"])):
        bad("STRUCT_PRODUCTION_DATE")
    if not isinstance(t.get("repeat"), bool):
        bad("STRUCT_REPEAT")
    d = out.get("due") or {}
    if not isinstance(d.get("need_confirm"), bool) or d.get("reason") not in REASONS:
        bad("STRUCT_DUE")
    if d.get("date") is not None and not (isinstance(d.get("date"), str) and DATE_RE.match(d["date"])):
        bad("STRUCT_DUE_DATE")
    if d.get("month") is not None and not (isinstance(d.get("month"), str) and MONTH_RE.match(d["month"])):
        bad("STRUCT_DUE_MONTH")
    sp = out.get("suggest_period")
    if sp is not None and (not isinstance(sp, dict) or sp.get("period_unit") not in UNITS or not isinstance(sp.get("period_value"), int)):
        bad("STRUCT_SUGGEST_PERIOD")
    if not isinstance(out.get("excluded_medical"), bool) or not isinstance(out.get("has_reminder"), bool):
        bad("STRUCT_FLAGS")

    # ---- 证据 ----
    quote = out.get("source_quote")
    if not isinstance(quote, str) or cp_len(quote) > QUOTE_MAX:
        bad("STRUCT_QUOTE")
        out["source_quote"] = ""
    elif quote and norm(quote) not in norm(text):
        bad("QUOTE_NOT_SUBSTRING")
        out["source_quote"] = ""

    if v:
        return out, v  # 结构问题直接上报,不做纪律修正

    # ---- R1 位置锚定(幻觉防线,同 extractDraft v2)----
    if out["location_certain"] and out["location_text"]:
        anchor = norm(out["source_quote"]) or norm(text)
        if norm(out["location_text"]) not in anchor:
            bad("R1_HALLUCINATED_LOCATION")
            out["location_certain"] = False
            out["location_text"] = ""

    # ---- R2 模糊表达绝不折算日期 ----
    if t["type"] == "vague" and (d["date"] is not None or d["month"] is not None or not d["need_confirm"]):
        bad("R2_VAGUE_DATE_FORBIDDEN")
        d["date"] = None
        d["month"] = None
        d["need_confirm"] = True

    # ---- R3 开封日未知不给日期 ----
    if t["type"] == "after_open" and t["base"] == "open_date_unstated" and d["date"] is not None:
        bad("R3_AFTER_OPEN_BASE_UNKNOWN")
        d["date"] = None
        d["need_confirm"] = True

    # ---- R4 月精度:只给 month,不给 date,必须确认 ----
    if d["month"] is not None and (d["date"] is not None or not d["need_confirm"]):
        bad("R4_MONTH_PRECISION")
        d["date"] = None
        d["need_confirm"] = True

    # ---- R5 免确认仅限「用户明说完整年月日」(纯位置记录无提醒,不适用)----
    if (
        out["has_reminder"]
        and d["reason"] != "NO_TASK"
        and not d["need_confirm"]
        and (d["date"] is None or t["type"] != "absolute_date" or d["month"] is not None)
    ):
        bad("R5_CONFIRM_FREE_TOO_LOOSE")
        d["need_confirm"] = True

    # ---- R6 医疗排除 ----
    if out["excluded_medical"] and out["has_reminder"]:
        bad("R6_MEDICAL_NOT_EXCLUDED")
        out["has_reminder"] = False
        d["date"] = None
        d["month"] = None
        d["need_confirm"] = True
        d["reason"] = "MEDICAL_EXCLUDED_ROUND1"

    # ---- R7 未明示周期不循环 ----
    if t["repeat"] and t["type"] != "recurring_period":
        bad("R7_REPEAT_WITHOUT_STATEMENT")
        t["repeat"] = False

    # ---- R8 计算类/换算类/星期/开封/模糊一律须确认 ----
    if t["type"] in NEED_CONFIRM_TYPES and not d["need_confirm"]:
        bad("R8_NEED_CONFIRM_REQUIRED")
        d["need_confirm"] = True

    return out, v


def deep_diff(a, b, path="$", out=None):
    """收集 a(实际)与 b(金标)的全部差异路径。"""
    if out is None:
        out = []
    if type(a) is not type(b):
        out.append("%s: %r != %r" % (path, a, b))
    elif isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append("%s.%s: <缺失> != %r" % (path, k, b[k]))
            elif k not in b:
                out.append("%s.%s: %r != <多余>" % (path, k, a[k]))
            else:
                deep_diff(a[k], b[k], "%s.%s" % (path, k), out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append("%s[len]: %d != %d" % (path, len(a), len(b)))
        for i, (x, y) in enumerate(zip(a, b)):
            deep_diff(x, y, "%s[%d]" % (path, i), out)
    elif a != b:
        out.append("%s: %r != %r" % (path, a, b))
    return out


def detect(row):
    """判定本句注入偏差是否被三层检测命中。"""
    inj = INJECTED.get(row["id"])
    if not inj:
        return None
    if row["parse_error"]:
        return "parse_error"
    if row["violations"]:
        return "validator:" + row["violations"][0]
    if row["diffs"]:
        return "comparator:" + row["diffs"][0].split(".")[1].split(":")[0] if "." in row["diffs"][0] else "comparator"
    return None  # 未检出 → 漏检


def main():
    corpus_rows = load_jsonl(CORPUS_PATH)
    corpus = {r["id"]: r for r in corpus_rows}
    mock_rows = load_jsonl(MOCK_PATH)
    if len(corpus) < 30:
        raise SystemExit("冻结语料不足 30 句(现 %d 句)" % len(corpus))

    results = []
    for m in mock_rows:
        cid = m["id"]
        row = {
            "id": cid,
            "category": corpus[cid]["category"],
            "parse_error": None,
            "violations": [],
            "diffs": [],
        }
        parsed = extract_json_object(m["response"])
        if parsed is None or not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list) or not parsed["items"]:
            row["parse_error"] = "RESPONSE_NOT_JSON"
            results.append(row)
            continue
        cleaned, v = validate_item(parsed["items"][0], corpus[cid]["text"])
        row["violations"] = v
        row["diffs"] = deep_diff(cleaned, corpus[cid]["gold"])
        results.append(row)

    injected_ids = set(INJECTED)
    detected = {r["id"]: detect(r) for r in results if r["id"] in injected_ids}
    missed = [i for i, how in detected.items() if how is None]
    clean_rows = [r for r in results if r["id"] not in injected_ids]
    clean_with_issues = [r for r in clean_rows if r["diffs"] or r["violations"] or r["parse_error"]]
    unknown_ids = [r["id"] for r in results if r["id"] not in corpus]

    ok = not missed and not clean_with_issues and not unknown_ids

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reference_date": REFERENCE_DATE,
        "note": "mock 评测:响应为固定 mock 文件,不涉及任何真实模型;检出结论只证明评测框架可用,不代表模型质量。",
        "sha256": {
            "corpus.jsonl": sha256_of(CORPUS_PATH),
            "mock-responses.jsonl": sha256_of(MOCK_PATH),
            "prompt-draft.txt": sha256_of(PROMPT_PATH),
        },
        "counts": {
            "corpus_sentences": len(corpus),
            "mock_responses": len(mock_rows),
            "injected_deviations": len(INJECTED),
            "injected_detected": len(INJECTED) - len(missed),
            "missed": missed,
            "clean_sentences": len(clean_rows),
            "clean_with_unexpected_issues": [r["id"] for r in clean_with_issues],
        },
        "rows": results,
        "verdict": "PASS" if ok else "FAIL",
    }

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    lines = [
        "# reminder-spike 离线 mock 评测报告(自动生成)",
        "",
        "- 生成时间:%s" % report["generated_at"],
        "- 参考日期(金标基准):%s" % REFERENCE_DATE,
        "- 声明:响应来自固定 mock 文件,零网络零 key;检出结论只证明**评测框架可跑**,不代表任何真实模型表现。真实 LLM 跑批为 TODO(需独立实验授权)。",
        "- sha256 留档:corpus=%s / mock=%s / prompt=%s" % (
            report["sha256"]["corpus.jsonl"][:16] + "…",
            report["sha256"]["mock-responses.jsonl"][:16] + "…",
            report["sha256"]["prompt-draft.txt"][:16] + "…",
        ),
        "",
        "| id | 类别 | 解析 | 纪律违规 | 金标差异 | 注入偏差检出 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for r in results:
        inj = INJECTED.get(r["id"], "")
        det = detected.get(r["id"], "") if r["id"] in detected else ""
        lines.append("| %s | %s | %s | %s | %s | %s |" % (
            r["id"], r["category"],
            r["parse_error"] or "ok",
            ",".join(r["violations"]) or "-",
            "; ".join(r["diffs"])[:80] or "-",
            ("%s → %s" % (inj, det)) if inj else "-",
        ))
    lines += [
        "",
        "## 汇总",
        "",
        "- 注入偏差 %d 处,检出 %d 处%s" % (len(INJECTED), len(INJECTED) - len(missed), (";漏检:" + ",".join(missed)) if missed else ""),
        "- 干净句 %d 句,意外差异/违规 %d 句%s" % (len(clean_rows), len(clean_with_issues), (":" + ",".join(r["id"] for r in clean_with_issues)) if clean_with_issues else ""),
        "- 结论:**%s**" % report["verdict"],
        "",
    ]
    with open(os.path.join(OUT_DIR, "report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print("语料 %d 句;mock %d 条;注入 %d 检出 %d;干净句意外问题 %d;结论 %s" % (
        len(corpus), len(mock_rows), len(INJECTED), len(INJECTED) - len(missed), len(clean_with_issues), report["verdict"]))
    print("sha256(corpus)=%s" % report["sha256"]["corpus.jsonl"])
    print("报告 → outputs/report.json / outputs/report.md")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
