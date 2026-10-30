import { locationArtworkId, locationArtworkSrc } from "./location-artwork";
import { getAppearance } from "./appearance";
/** Approved prototype artwork; unknown names keep a neutral storage/item drawing. */
export function roomArtwork(name: string, dark = false, override?: unknown): string {
  return locationArtworkSrc(locationArtworkId(name, override), dark);
}

export function itemArtwork(name: string, dark = false): string {
  const kind = /钥匙/.test(name) ? "key"
    : /药|维生素|保健|胶囊/.test(name) ? "medicine"
    : /书|说明|笔记|相册|文件/.test(name) ? "book"
    : "generic";
  return `${getAppearance().artPrefix}${kind}${dark ? "-dark" : ""}.png`;
}
