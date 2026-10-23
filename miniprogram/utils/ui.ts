import { getAppearance } from "./appearance";
/** Approved prototype artwork; unknown names keep a neutral storage/item drawing. */
export function roomArtwork(name: string, dark = false): string {
  const kind = /厨房|餐厅|餐厨/.test(name) ? "kitchen"
    : /书房|办公室|工作间/.test(name) ? "study"
    : /卧室|主卧|次卧|儿童房|客房/.test(name) ? "bedroom"
    : /客厅|起居|玄关/.test(name) ? "living"
    : "storage";
  return `${getAppearance().artPrefix}${kind}${dark ? "-dark" : ""}.png`;
}

export function itemArtwork(name: string, dark = false): string {
  const kind = /钥匙/.test(name) ? "key"
    : /药|维生素|保健|胶囊/.test(name) ? "medicine"
    : /书|说明|笔记|相册|文件/.test(name) ? "book"
    : "generic";
  return `${getAppearance().artPrefix}${kind}${dark ? "-dark" : ""}.png`;
}
