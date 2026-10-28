"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roomArtwork = roomArtwork;
exports.itemArtwork = itemArtwork;
const location_artwork_1 = require("./location-artwork");
const appearance_1 = require("./appearance");
/** Approved prototype artwork; unknown names keep a neutral storage/item drawing. */
function roomArtwork(name, dark = false, override) {
    return (0, location_artwork_1.locationArtworkSrc)((0, location_artwork_1.locationArtworkId)(name, override), dark);
}
function itemArtwork(name, dark = false) {
    const kind = /钥匙/.test(name) ? "key"
        : /药|维生素|保健|胶囊/.test(name) ? "medicine"
            : /书|说明|笔记|相册|文件/.test(name) ? "book"
                : "generic";
    return `${(0, appearance_1.getAppearance)().artPrefix}${kind}${dark ? "-dark" : ""}.png`;
}
