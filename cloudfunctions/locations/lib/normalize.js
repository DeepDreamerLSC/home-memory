/*
 * 【逐字节同源副本】本注释块以下的内容与 cloudfunctions/itemsApi/lib/normalize.js
 * 逐字节一致,修改任一份必须双向同步(纪律见 docs/design/location-tree.md §4.2;
 * 漂移由 tests/locations.test.js 的 TS-SRC 逐字节比对测试拦截)。
 * ---- 副本正文(与源文件逐字节一致)----
 */
"use strict";

/**
 * 名称归一化(docs/API_CONTRACT.md「normalizeName(s)」)。
 * 顺序固定:NFC 归一 → 全角转半角 → 小写 → 去所有空白字符 → 去中英文标点。
 * name_norm 与查询词都必须经过本函数。
 */

// 全角字符区 U+FF01–U+FF5E 与 ASCII 0x21–0x7E 一一对应,差 0xFEE0。
// U+3000(全角空格)不在该区,单独映射为半角空格(随后作为空白被移除)。
var FULLWIDTH_START = 0xff01;
var FULLWIDTH_END = 0xff5e;
var FULLWIDTH_OFFSET = 0xfee0;

function toHalfwidth(str) {
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code >= FULLWIDTH_START && code <= FULLWIDTH_END) {
      out += String.fromCharCode(code - FULLWIDTH_OFFSET);
    } else if (code === 0x3000) {
      out += " ";
    } else {
      out += str.charAt(i);
    }
  }
  return out;
}

function normalizeName(s) {
  if (typeof s !== "string") {
    return "";
  }
  var str = s.normalize("NFC");
  str = toHalfwidth(str);
  str = str.toLowerCase();
  // \s 覆盖所有 Unicode 空白(含 \u3000、\u00a0 等)
  str = str.replace(/\s/g, "");
  // \p{P} 为全部 Unicode 标点,涵盖中英文标点(,。!?・「」等),不伤汉字与字母数字
  str = str.replace(/\p{P}/gu, "");
  return str;
}

module.exports = { normalizeName: normalizeName };
