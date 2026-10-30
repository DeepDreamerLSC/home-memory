"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOCATION_ARTWORK = void 0;
exports.isLocationArtworkId = isLocationArtworkId;
exports.locationArtworkId = locationArtworkId;
exports.locationArtworkSrc = locationArtworkSrc;
const appearance_1 = require("./appearance");
/** Approved location-artwork-v1 catalog; categories organize artwork only, never the location tree. */
exports.LOCATION_ARTWORK = [
    {
        "id": "living",
        "name": "客厅",
        "category": "空间",
        "keywords": [
            "客厅",
            "起居室",
            "客厅区"
        ]
    },
    {
        "id": "bedroom",
        "name": "卧室",
        "category": "空间",
        "keywords": [
            "卧室",
            "主卧",
            "次卧",
            "儿童房",
            "客房"
        ]
    },
    {
        "id": "study",
        "name": "书房",
        "category": "空间",
        "keywords": [
            "书房",
            "办公室",
            "工作间"
        ]
    },
    {
        "id": "kitchen",
        "name": "厨房",
        "category": "空间",
        "keywords": [
            "厨房",
            "餐厨",
            "餐厅"
        ]
    },
    {
        "id": "bathroom",
        "name": "卫生间",
        "category": "空间",
        "keywords": [
            "卫生间",
            "洗手间",
            "浴室",
            "厕所"
        ]
    },
    {
        "id": "balcony",
        "name": "阳台",
        "category": "空间",
        "keywords": [
            "阳台",
            "露台"
        ]
    },
    {
        "id": "entryway",
        "name": "玄关",
        "category": "空间",
        "keywords": [
            "玄关",
            "门口",
            "入户",
            "门厅"
        ]
    },
    {
        "id": "car",
        "name": "车内",
        "category": "空间",
        "keywords": [
            "车内",
            "汽车",
            "车里",
            "车上",
            "轿车",
            "车"
        ]
    },
    {
        "id": "wardrobe",
        "name": "衣柜",
        "category": "家具",
        "keywords": [
            "衣柜",
            "衣橱",
            "衣帽柜"
        ]
    },
    {
        "id": "bookshelf",
        "name": "书柜",
        "category": "家具",
        "keywords": [
            "书柜",
            "书架",
            "图书架"
        ]
    },
    {
        "id": "refrigerator",
        "name": "冰箱",
        "category": "家具",
        "keywords": [
            "冰箱",
            "冷藏柜",
            "冷冻柜"
        ]
    },
    {
        "id": "desk",
        "name": "桌子",
        "category": "家具",
        "keywords": [
            "桌子",
            "书桌",
            "办公桌",
            "工作台",
            "桌面"
        ]
    },
    {
        "id": "nightstand",
        "name": "床头柜",
        "category": "家具",
        "keywords": [
            "床头柜",
            "床边柜"
        ]
    },
    {
        "id": "shoe-cabinet",
        "name": "鞋柜",
        "category": "家具",
        "keywords": [
            "鞋柜",
            "鞋架"
        ]
    },
    {
        "id": "drawer-unit",
        "name": "抽屉柜",
        "category": "家具",
        "keywords": [
            "抽屉柜",
            "斗柜",
            "五斗柜",
            "三斗柜"
        ]
    },
    {
        "id": "wall-cabinet",
        "name": "吊柜",
        "category": "家具",
        "keywords": [
            "吊柜",
            "壁柜",
            "墙柜"
        ]
    },
    {
        "id": "drawer",
        "name": "抽屉",
        "category": "收纳",
        "keywords": [
            "抽屉"
        ]
    },
    {
        "id": "storage-box",
        "name": "收纳箱",
        "category": "收纳",
        "keywords": [
            "收纳箱",
            "收纳盒",
            "塑料箱",
            "塑料盒",
            "整理箱",
            "透明箱"
        ]
    },
    {
        "id": "carton",
        "name": "纸箱",
        "category": "收纳",
        "keywords": [
            "纸箱",
            "纸盒",
            "快递箱",
            "快递盒"
        ]
    },
    {
        "id": "basket",
        "name": "收纳篮",
        "category": "收纳",
        "keywords": [
            "收纳篮",
            "篮子",
            "藤篮",
            "竹篮",
            "脏衣篮"
        ]
    },
    {
        "id": "document-folder",
        "name": "文件盒",
        "category": "收纳",
        "keywords": [
            "文件盒",
            "文件夹",
            "档案盒",
            "资料盒",
            "文件收纳"
        ]
    },
    {
        "id": "suitcase",
        "name": "行李箱",
        "category": "收纳",
        "keywords": [
            "行李箱",
            "旅行箱",
            "拉杆箱",
            "皮箱"
        ]
    },
    {
        "id": "toolbox",
        "name": "工具箱",
        "category": "收纳",
        "keywords": [
            "工具箱",
            "工具盒",
            "五金箱",
            "维修箱"
        ]
    },
    {
        "id": "generic",
        "name": "通用位置",
        "category": "收纳",
        "keywords": []
    }
];
function isLocationArtworkId(value) {
    return typeof value === "string" && exports.LOCATION_ARTWORK.some(item => item.id === value);
}
function locationArtworkId(name, override) {
    if (isLocationArtworkId(override))
        return override;
    const normalized = (name || "").trim().toLowerCase();
    let selected = "generic";
    let specificity = 0;
    for (const item of exports.LOCATION_ARTWORK) {
        for (const keyword of item.keywords) {
            if (keyword.length > specificity && (keyword.length === 1 ? normalized === keyword.toLowerCase() : normalized.includes(keyword.toLowerCase()))) {
                selected = item.id;
                specificity = keyword.length;
            }
        }
    }
    return selected;
}
function locationArtworkSrc(id, dark = false) {
    const safeId = isLocationArtworkId(id) ? id : "generic";
    return `/assets/location-artwork/${(0, appearance_1.getAppearance)().settings.palette}/${safeId}${dark ? "-dark" : ""}.png`;
}
