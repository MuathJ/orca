# Browser Computer Use Promo

## Problem
Browser Use setup is in **Browser** settings, while **Computer Use** is a separate section. Users are not told that Computer Use can control already-authenticated desktop apps (including system browsers), which can be lower-friction than cookie import for some tasks.

## Current constraints (code-verified)
- `BrowserUseSetup` currently accepts only `onConfigureMoreBrowsers?: () => void` (`BrowserUsePane.tsx`).
- `BrowserPane` is desktop-only because the entire Browser section is gated by `showDesktopOnlySettings` in `Settings.tsx`.
- Browser Use toggle and “skill installed” are persisted in `localStorage` keys (`BROWSER_USE_ENABLED_STORAGE_KEY`, `BROWSER_USE_SKILL_INSTALLED_STORAGE_KEY`), but each window keeps its own React state copy after initial read (no `storage` event sync).
- Computer Use section id is `computer-use` (`SettingsSection id`).
- Settings search filters section mounting; filtered sections are absent from the DOM.
- Canonical jump behavior already exists in `Settings.tsx` via `pendingNavSectionRef`, `pendingScrollTargetRef`, `scrollSectionIntoView`, and `flashSectionHighlight`.
- `ComputerUsePane` always renders the skill install block; macOS permission controls render only when platform resolves to macOS.

## Goal
Add a compact promo inside expanded Browser Use that links to Computer Use and uses the existing Settings pending-nav jump path.

## Non-goals
- No Computer Use controls duplicated inside Browser.
- No Browser Use step semantics changes.
- No Computer Use backend/API changes.

## Implementation
1. Add `onOpenComputerUse?: () => void` to `BrowserUseSetupProps`.
2. Thread that prop through `BrowserPaneProps` and pass it from `BrowserPane` to `BrowserUseSetup`.
3. In `Settings.tsx`, pass `onOpenComputerUse` into `BrowserPane` that:
- sets `pendingNavSectionRef.current = 'computer-use'`
- sets `pendingScrollTargetRef.current = 'computer-use'`
- clears search only if non-empty (`setSettingsSearchQuery('')`) so the section can mount
4. Rely on existing `visibleNavSections` effect to execute scroll + flash and clear pending refs.
5. Render promo only when Browser Use is enabled/expanded and callback exists.
6. Place promo at top of expanded Browser Use card, before Step 1.
7. Style with existing tokens/primitives only (`rounded-xl border border-border/60 bg-card/50`, existing `Button` variants, `MousePointerClick` icon).

Do not implement ad-hoc local scroll logic in `BrowserUsePane` for this jump; keep section navigation centralized in `Settings.tsx`.

## Copy constraints
- State capability, not guarantee: Computer Use can control local apps and may use existing logged-in sessions where applicable.
- State prerequisites: Computer Use skill install is required; macOS permissions are additionally required on macOS.
- Position as an alternative path, not a replacement for Browser Use cookie import.

## Edge cases to handle
- Active search currently filters out `computer-use`.
- Repeated CTA clicks before prior pending jump resolves (last click should remain idempotent).
- Browser Use collapsed/disabled (no promo).
- Multi-window state drift: localStorage-backed Browser Use UI state is not live-synced across open windows.
- Non-mac platforms: CTA remains valid (skill flow still exists even without mac permission rows).
- Web client: Browser section is absent, so promo path is unreachable by design.

## Search indexing
Update `BROWSER_USE_PANE_SEARCH_ENTRIES` to add intent terms for this promo while keeping existing terms:
- `computer use`
- `system browser`
- `existing session`
- `authenticated browser`
- `chrome profile`
- `edge profile`
- `arc profile`

## Acceptance criteria
- Expanded Browser Use shows promo + CTA.
- CTA lands on `computer-use`, flashes section highlight, and works when search filters are active.
- No Browser Use step behavior changes.
- No duplicated Computer Use controls in Browser.
