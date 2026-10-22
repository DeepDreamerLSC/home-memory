"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roomArtwork = roomArtwork;
exports.itemArtwork = itemArtwork;
/** Approved prototype artwork; unknown names keep a neutral storage/item drawing. */
function roomArtwork(name, dark = false) {
    const kind = /厨房|餐厅|餐厨/.test(name) ? "kitchen"
        : /书房|办公室|工作间/.test(name) ? "study"
            : /卧室|主卧|次卧|儿童房|客房/.test(name) ? "bedroom"
                : /客厅|起居|玄关/.test(name) ? "living"
                    : "storage";
    return `/assets/rooms/${kind}${dark ? "-dark" : ""}.png`;
}
function itemArtwork(name, dark = false) {
    const kind = /钥匙/.test(name) ? "key"
        : /药|维生素|保健|胶囊/.test(name) ? "medicine"
            : /书|说明|笔记|相册|文件/.test(name) ? "book"
                : "generic";
    return `/assets/items/${kind}${dark ? "-dark" : ""}.png`;
}
