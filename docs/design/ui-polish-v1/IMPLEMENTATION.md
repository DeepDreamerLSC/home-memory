# 已批准 UI 的小程序实现

2026-10-22，参考同目录 `index.html` 的精简版。执行口径见仓库根目录 `DESIGN.md`。

## 交付范围

- 首页：真实总数、房间插画、搜索、近期记录、轻量到期提示；首用态独立引导。
- 常驻录入栏：语音和加号，展开后进入现有文字、拍照、视频页面。
- 单件核对：直接编辑字段、归位预览、固定确认操作；多件、不确定、缺依据、提醒及部分失败保留既有门禁。
- 详情：物品插画或真实照片、上次记录位置、记录更新时间、原话折叠、固定“找到了 / 更新位置”。找到了仅返回，不写入新事实。
- 深浅色、图片、页面间距和视频页缺失颜色变量统一。

## 对照约束

原型使用示例内容；实现使用真实记录、路径和计数。为避免把任意字段更新冒充位置确认，详情保留“记录更新于”，位置标签为“上次记录位置”。真实位置原文不做推断或删改。复杂状态使用同一套视觉规则，提示不能为追求简洁而隐藏。

状态栏、系统返回和微信胶囊由微信渲染。所有尺寸按375px画布换算rpx。最终确认版保留按钮高度，将按钮下方总留白（含安全区留白）减半，见下方调整说明。截图对照排除系统时间和平台原生导航几何。

## 素材

本地图片由已批准原型中的矢量符号生成，包含浅色、深色和未知内容的中性回退；运行时不依赖网络。生成脚本为 `scripts/generate-ui-assets.js`，使用环境已提供的 Sharp，无新增项目依赖。

本会话复现：

```sh
NODE_PATH=/Users/linsuchang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/generate-ui-assets.js
```

## 验证复现

```sh
npm run typecheck
npm test
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project /Users/linsuchang/Desktop/work/github/home-memory --auto-port 9420
WECHAT_AUTO_ENDPOINT=ws://127.0.0.1:9433 node tests/e2e/ui-polish.js
```

本机已打开的自动化会话实际监听9433；新会话按工具实际端口设置环境变量。E2E截图使用390px宽、753px内容区的微信模拟器，路由为首页、手动/草稿核对和物品详情。所有种子值通过setData注入内存，不向云端保存。

本地证据在 `.omx/artifacts/ui-polish-v1/`：`home.png`、`first-use.png`、`add-sheet.png`、`manual.png`、`confirm.png`、`detail.png`、`checks.json`；视觉结论在 `.omx/state/ui-polish-v1/ralph-progress.json`。预览和上传由微信CLI执行，回执另存同目录。开发包上传和正式发布状态分别记录，不混称。

## 初版开发包上传回执

- 微信开发版本：`0.11.0`；CLI upload 成功。包体积740696字节（723.3KB）。
- 同一代码快照的CLI preview成功，二维码在 `.omx/artifacts/ui-polish-v1/preview-qr.png`。
- TypeScript检查通过；1041项离线回归通过，0失败；原生七项UI流程及可选备注入口通过，UI验证不写云端记录。
- 视觉验收94/100；共同内容区像素差异4.52%，用于定位差异，不作为验收分数。`home-overlay.png`、`home-diff.png` 和 `pixel-diagnostic.json` 为辅助证据。
- 本次为开发包上传和预览，未提交微信审核或正式发布。
- 代码快照SHA-256：`e4d8f8c31d778deb09e567bd8a65ba9256c9f42e3893f3c67710498f7a54107f`。

## 最终确认版：底部留白减半

用户在初版预览后确认保留按钮高度，将首页共享录入栏、核对页和详情页固定操作栏下方总留白减半：`calc(16rpx + env(safe-area-inset-bottom))` 改为 `calc(8rpx + env(safe-area-inset-bottom) / 2)`。模拟器实测留白由42px变为21px，首页按钮高度仍为53px，未与系统手势指示条重叠。

- 24项相关测试、原生七项UI流程和可选备注交互通过；验证不写云端。
- 最终代码已成功生成新的微信预览包（740705字节），二维码及回执在 `.omx/artifacts/bottom-gap-v1/`。本次调整后未再次上传开发版本；上方0.11.0回执仅对应初版快照。
- 最终原生浅色截图已归档至 `screenshots/home.png`、`screenshots/confirm.png`、`screenshots/detail.png`。截图内容为内存样例，非用户云端记录。
- 深色主题已实现，最终这一轮未做深色模拟器或真机复验；未提交审核或正式发布。

像素诊断复现：先用浏览器保存原型 `#content` 内容区域截图为 `reference-home-content.png`，再运行：

```sh
NODE_PATH=/Users/linsuchang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules node scripts/compare-ui-capture.js
```
