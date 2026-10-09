"use strict";

/**
 * 内存版 CloudBase 文档数据库语义(docs/API_CONTRACT.md「离线测试规范」)。
 * 支持:
 *   db.collection(name).add({ data: doc })            → Promise<{ _id }>(与真实 SDK 一致:数据在 data 字段里)
 *   db.collection(name).where(cond).get()             → Promise<{ data: docs }>(AND 等值匹配)
 *   db.collection(name).where(cond).update({ data: patch }) → Promise<{ stats:{ updated: n } }>(与真实 SDK 一致)
 *   db.collection(name).where(cond).skip(n).limit(n).get()  → 同上,分页语义同 CloudBase
 *   db.collection(name).doc(id).get()                 → Promise<{ data: doc|null }>
 *   db.collection(name).doc(id).update(data)          → Promise<{ stats:{ updated: n } }>
 * get() 未显式 .limit() 时最多返回 GET_DEFAULT_LIMIT 条,模拟 CloudBase 云函数端
 * get() 默认单次最多 100 条的真实行为(超过会被截断),让分页缺失可被测试发现。
 * 不依赖任何外部包;测试绝不 require wx-server-sdk。
 */

// CloudBase 云函数端 get() 默认单次最多返回 100 条
var GET_DEFAULT_LIMIT = 100;

function clone(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function matches(doc, cond) {
  var keys = Object.keys(cond);
  for (var i = 0; i < keys.length; i++) {
    if (doc[keys[i]] !== cond[keys[i]]) {
      return false;
    }
  }
  return true;
}

function applyPatch(doc, data) {
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i++) {
    doc[keys[i]] = data[keys[i]];
  }
}

function createMemoryDb() {
  var store = Object.create(null); // name -> 文档数组

  function docsOf(name) {
    if (!Object.prototype.hasOwnProperty.call(store, name)) {
      store[name] = [];
    }
    return store[name];
  }

  function collection(name) {
    return {
      add: function (options) {
        // 与真实 wx-server-sdk 一致:add({ data: doc });裸传 doc 时数据不落库(只得到空文档)
        var doc = clone(options && options.data) || {};
        var docs = docsOf(name);
        // 模拟真实环境的 (household_id, operation_id) 组合唯一索引:
        // 两字段都存在的文档重复时,以 E11000 同款错误拒绝插入
        if (doc.household_id !== undefined && doc.operation_id !== undefined) {
          var clash = docs.some(function (d) {
            return d.household_id === doc.household_id && d.operation_id === doc.operation_id;
          });
          if (clash) {
            return Promise.reject(
              new Error(
                "collection.add:fail -502001 database request fail. [FailedOperation.Insert] " +
                  "bulk write error: E11000 duplicate key error collection: items " +
                  "index: uniq_household_operation"
              )
            );
          }
        }
        var id = doc._id;
        if (id === undefined || id === null) {
          id = "mem-" + docs.length + "-" + Math.random().toString(36).slice(2, 10);
          doc._id = id;
        }
        docs.push(doc);
        return Promise.resolve({ _id: id });
      },
      where: function (cond) {
        var skipCount = 0;
        var limitCount; // undefined = 未显式指定,按云函数端默认上限截断
        var query = {
          limit: function (n) {
            limitCount = n;
            return query;
          },
          skip: function (n) {
            skipCount = n;
            return query;
          },
          get: function () {
            var found = docsOf(name)
              .filter(function (d) {
                return matches(d, cond);
              })
              .map(clone);
            var take = limitCount === undefined ? GET_DEFAULT_LIMIT : limitCount;
            return Promise.resolve({ data: found.slice(skipCount, skipCount + take) });
          },
          update: function (options) {
            // 与真实 wx-server-sdk 一致:update({ data: {...} });裸传对象会被 SDK 拒绝
            if (!options || typeof options !== "object" || options.data === undefined) {
              return Promise.reject(new Error("parameter should be object instead of undefined"));
            }
            var patch = clone(options.data) || {};
            var updated = 0;
            var docs = docsOf(name);
            for (var i = 0; i < docs.length; i++) {
              if (matches(docs[i], cond)) {
                applyPatch(docs[i], patch);
                updated += 1;
              }
            }
            return Promise.resolve({ stats: { updated: updated } });
          }
        };
        return query;
      },
      doc: function (id) {
        return {
          get: function () {
            var docs = docsOf(name);
            var found = null;
            for (var i = 0; i < docs.length; i++) {
              if (docs[i]._id === id) {
                found = clone(docs[i]);
                break;
              }
            }
            return Promise.resolve({ data: found });
          },
          update: function (options) {
            // 与真实 wx-server-sdk 一致:update({ data: {...} });裸传对象会被 SDK 拒绝
            if (!options || typeof options !== "object" || options.data === undefined) {
              return Promise.reject(new Error("parameter should be object instead of undefined"));
            }
            var patch = clone(options.data) || {};
            var docs = docsOf(name);
            for (var i = 0; i < docs.length; i++) {
              if (docs[i]._id === id) {
                applyPatch(docs[i], patch);
                return Promise.resolve({ stats: { updated: 1 } });
              }
            }
            return Promise.resolve({ stats: { updated: 0 } });
          }
        };
      }
    };
  }

  return { collection: collection };
}

module.exports = { createMemoryDb: createMemoryDb };
