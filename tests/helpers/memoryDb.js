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
 *   db.collection(name).doc(id).remove()              → Promise<{ stats:{ removed: n } }>
 *   db.collection(name).where(cond).remove()          → Promise<{ stats:{ removed: n } }>
 * get() 未显式 .limit() 时最多返回 GET_DEFAULT_LIMIT 条,模拟 CloudBase 云函数端
 * get() 默认单次最多 100 条的真实行为(超过会被截断),让分页缺失可被测试发现。
 * 唯一索引模拟按集合可配置:createMemoryDb({ uniqueIndexes: { <集合名>: [[字段..]..] } }),
 * 与默认的 items (household_id, operation_id) 合并(集合级覆盖);命中唯一键重复时
 * 以 E11000 同款错误拒绝插入(locations 集合的 (household_id, parent_id, name_norm)
 * 即由此模拟,见 docs/design/location-tree.md §9)。
 * 不依赖任何外部包;测试绝不 require wx-server-sdk。
 */

// CloudBase 云函数端 get() 默认单次最多返回 100 条
var GET_DEFAULT_LIMIT = 100;

// 默认唯一索引:items 的 (household_id, operation_id)(与线上索引一致)
var DEFAULT_UNIQUE_INDEXES = {
  items: [["household_id", "operation_id"]],
  // 物品锁以 _id 作为锁键,抢锁 add 的并发语义必须与真实库一致;仅对该集合启用,
  // 不改变其他既有测试对 _id 的宽松假设。
  video_item_locks: [["_id"]],
};

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

function createMemoryDb(options) {
  options = options || {};
  var store = Object.create(null); // name -> 文档数组

  // 唯一索引配置按集合合并:默认 items (household_id, operation_id) 行为不变,
  // 测试可为新集合(如 locations)声明自己的组合唯一键,集合级显式传入则覆盖默认
  var uniqueIndexes = {};
  var collectionNames = Object.keys(DEFAULT_UNIQUE_INDEXES).concat(
    Object.keys(options.uniqueIndexes || {})
  );
  for (var c = 0; c < collectionNames.length; c++) {
    var cname = collectionNames[c];
    uniqueIndexes[cname] = (options.uniqueIndexes && options.uniqueIndexes[cname]) ||
      DEFAULT_UNIQUE_INDEXES[cname];
  }

  /** 返回命中的唯一索引名(uniq_字段拼接),未命中返回 null;字段部分缺失不算命中 */
  function violatedUniqueIndex(name, doc, docs) {
    var indexes = uniqueIndexes[name] || [];
    for (var k = 0; k < indexes.length; k++) {
      var fields = indexes[k];
      var allPresent = true;
      for (var f = 0; f < fields.length; f++) {
        if (doc[fields[f]] === undefined) {
          allPresent = false;
          break;
        }
      }
      if (!allPresent) {
        continue;
      }
      var clash = docs.some(function (d) {
        for (var f2 = 0; f2 < fields.length; f2++) {
          if (d[fields[f2]] !== doc[fields[f2]]) {
            return false;
          }
        }
        return true;
      });
      if (clash) {
        return "uniq_" + fields.join("_");
      }
    }
    return null;
  }

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
        // 模拟真实环境的组合唯一索引(按集合可配置,默认 items 的
        // (household_id, operation_id)):索引字段全部存在的文档重复时,
        // 以 E11000 同款错误拒绝插入
        var indexName = violatedUniqueIndex(name, doc, docs);
        if (indexName) {
          return Promise.reject(
            new Error(
              "collection.add:fail -502001 database request fail. [FailedOperation.Insert] " +
                "bulk write error: E11000 duplicate key error collection: " + name +
                " index: " + indexName
            )
          );
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
          },
          remove: function () {
            // 与真实 wx-server-sdk 一致:where().remove() 删除全部命中文档
            var kept = [];
            var docs = docsOf(name);
            var removed = 0;
            for (var i = 0; i < docs.length; i++) {
              if (matches(docs[i], cond)) {
                removed += 1;
              } else {
                kept.push(docs[i]);
              }
            }
            store[name] = kept;
            return Promise.resolve({ stats: { removed: removed } });
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
          },
          remove: function () {
            // 与真实 wx-server-sdk 一致:doc(id).remove() 删除单文档
            var docs = docsOf(name);
            for (var i = 0; i < docs.length; i++) {
              if (docs[i]._id === id) {
                docs.splice(i, 1);
                return Promise.resolve({ stats: { removed: 1 } });
              }
            }
            return Promise.resolve({ stats: { removed: 0 } });
          }
        };
      }
    };
  }

  return { collection: collection };
}

module.exports = { createMemoryDb: createMemoryDb };
