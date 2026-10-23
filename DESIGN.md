# Design

## Source of truth
- Active; approved 2026-10-22. Reference: `docs/design/ui-polish-v1/index.html`, including the approved copy reduction.
- Primary surfaces: home, first use, recording methods, confirmation, item detail.
- Existing contracts: `docs/API_CONTRACT.md`; complex photo/video, reminder and family states remain available.

## Brand
Warm, calm and lightly conversational. Use the product name in native navigation. Keep explanations short and avoid decorative emoji, repeated slogans and heavy shadows.

## Product goals
Find a recorded location quickly; record an item through voice, text, photo or video; make confirmation explicit. Success means the primary task is obvious and existing household/write guards remain intact.

## Personas and jobs
Household members recording where they put something and returning later to find it. Favor readable Chinese and direct touch actions.

## Information architecture
Home → room or search → item. Voice or addition → confirmation. Family selection stays accessible in both first-use and populated states. Advanced management and evidence remain secondary.

## Design principles
Show recorded facts before operations. Use one primary action per task: record on home, confirm on confirmation, found on detail. Display uncertainty and partial failure where the user must act.

## Visual language
- Tokens live in `miniprogram/app.wxss`; navigation colors live in `miniprogram/theme.json`.
- Light: paper `#f8f7f2`, surface `#fffefa`, ink `#292d25`, action `#30372c`, yellow `#efd36e`. Dark uses the same semantic tokens.
- Use the system Chinese font. Titles 54rpx/600, item names 26–28rpx/500, secondary text 22–24rpx/400.
- Convert the 375px design canvas at 2rpx per px. Content inset 44rpx; card gap 24rpx; card radius 34rpx; input radius 24rpx; action radius 28–32rpx.
- Room and item drawings are local light/dark PNGs exported from the approved vector reference. Unknown content uses neutral storage/item art.
- Restrained press feedback; honor reduced-motion preferences. No hard elevation on ordinary content.

## Components
Reuse the existing `voice-bar`, global tokens and guarded page actions. Its add menu routes to existing text/photo/video pages. Detail and confirmation have task-specific fixed action bars. Artwork selection is owned by `miniprogram/utils/ui.ts`.

## Accessibility
Actions retain at least 88rpx touch areas; use native buttons for discrete actions. Keep uncertainty visible, labels explicit, and themed artwork mutually exclusive. Recording remains a press-and-release interaction with cancel feedback.

## Responsive behavior
Use rpx for supported phone widths and wrap long item/location names. Per the 2026-10-22 follow-up, fixed action bars retain their button heights and halve the full gap below buttons: `calc(8rpx + env(safe-area-inset-bottom) / 2)`. Native status/navigation/capsule geometry belongs to WeChat.

## Interaction states
Loading uses geometry-matched skeletons; first use explains one recording action; errors retain retry paths; success uses concise feedback. Disabled and in-flight actions cannot open competing flows. Stale data stays labeled.

## Content voice
Short Chinese labels: 搜索物品、房间、最近记住、按住说话、核对记录、确认记住. Keep “确认后才保存” and “物品可能已移动”. `updated_at` describes record updates, never a new position confirmation.

## Implementation constraints
Native WXML/WXSS/TypeScript; no framework or runtime dependency changes. Real content and counts come from existing APIs. Never copy fixture values into production behavior. Build committed JS through `npm run build:mp`.

## Verification
`npm test`, `npm run typecheck`, real WeChat preview compilation, and `tests/e2e/ui-polish.js`. The rendering check uses only in-memory fixtures and never submits cloud writes. Generation and comparison evidence: `docs/design/ui-polish-v1/IMPLEMENTATION.md`.

## Open questions
None required for the approved UI implementation; any future visual direction change needs a new reference.

## Quantity management proposal
- Draft UI proposal, 2026-10-23, based on issues #102 and #101. Reference: `docs/design/quantity-v1/index.html` and `README.md`. This is a standalone prototype, not implementation authorization.
- Extend existing list/detail/confirmation pages with last-confirmed quantity and unit; show legacy unset explicitly and preserve zero-quantity records.
- Voice adjustments show target, original value, operation and result before explicit confirmation. Ambiguous targets, mismatched units, version conflicts and unknown write results require user resolution.
- Photo/video candidate grouping is explicit. Observation counts never imply quantity; retain original sources, and use whole-photo evidence when multiple boxes are combined.
- Keep the existing visual tokens and short Chinese copy; no separate inventory navigation, low-stock thresholds or automatic deduction.
