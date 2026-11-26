# Windows, workspaces and panes

Design note for how the Electron app (`apps/key-office/apps/key`) arranges workspaces, windows, tabs and splits. It records the options we considered, the model we chose and how it is implemented.

## Where we started

- Several `BrowserWindow`s share one main process, one workspace registry and one set of owned views (`views` in `src/main/index.ts`). A document is open at most once. Its native `WebContentsView` moves between windows without reloading.
- Each window has a strip of tabs. A tab holds one view, or two views side by side (`viewIds: [a] | [a, b]` with one `splitRatio`). Tabs can be reordered, split by dropping one onto another, swapped and separated. They can also be moved to another window from the context menu.
- Windows were not tied to a workspace. The sidebar followed whichever view had focus, so a window could show records from several libraries and the sidebar jumped between them.
- Nothing was restored on relaunch.

## Questions

1. **Workspaces and windows.** Should a window show one workspace, or work like VS Code, where a window opens a workspace and switching replaces it?
2. **Tiling.** Should splits be freely nested, or work like VS Code editor groups?

## What matters for Key

- **Research sessions are arrangements.** A typical working set is a reader with its source page and a note, or two papers side by side with notes below. People switch between whole arrangements more often than they swap one document inside a fixed frame.
- **Libraries are separate.** Every workspace has its own `key.db`, collections and notes. Mixing them in one window, with a sidebar that changes under the user, causes mistakes such as filing a note into the wrong library.
- **macOS conventions.** The title bar holds a single tab strip next to the traffic lights, as in Safari, Finder and Ghostty. Each window represents one document or place, and its title says which one. Cmd-click and Option-click open things in a new window. Shortcuts follow Safari and iTerm2 or Ghostty: Cmd-1…9, Cmd-Shift-[ and ], Cmd-D style splits, and Cmd-Option-arrows to move between panes.
- **Native views.** PDFs and Office editors are native `WebContentsView`s stacked above the shell DOM. Each additional visible tab strip has to be laid out around them, and any DOM drawn over them, such as a drop preview, needs the captured-frame overlay that modals already use.

## Options

### A. A window may hold any workspace (the old behaviour)

The fewest rules. But the sidebar has no stable subject, "new note" goes wherever the last focus was, and the window title cannot name a library. Rejected.

### B. One workspace per window, VS Code style

A window shows one workspace. The switcher in the sidebar replaces the window's contents. The arrangement you leave is saved and returns when you switch back. Cmd-click or "Open in New Window" opens the workspace beside the current one. If another window already shows that workspace, the switcher brings that window forward instead of opening the workspace twice.

- **Benefits:** the sidebar, new items and the window title always refer to one library. Several libraries can stay on screen in separate windows, each with its own arrangement. The Window menu lists them by name.
- **Costs:** switching closes the views it leaves. Their arrangement is restored on return, but PDFs reload and unsaved record drafts trigger the usual discard prompt.

Views that belong to another workspace, such as results from a search across all workspaces, can still open in a window. They keep their own `workspaceId` and do not change the sidebar.

### C. VS Code editor groups

The window body is a grid of groups, and each group has its own tab strip. Tabs move between groups, and a group can split in any direction.

- **Benefits:** very flexible for one-document-at-a-time editing.
- **Costs for Key:**
  - It breaks the single title-bar tab strip that the shell and its smoke tests are built around.
  - Every group needs its own strip laid out around the native views.
  - Switching what you are working on means changing each group separately, which works against arrangements.
  - Each group's strip spends vertical space that PDFs need.

### D. Tabs that hold split layouts (Ghostty, iTerm2, Arc)

Keep the single title-bar strip. Each tab owns a layout tree: panes split left/right or top/bottom, nested to any depth, and each split has its own draggable divider. Drag a tab or pane onto an edge of a pane to split there, onto its centre to swap, or out of its group to separate it. Panes move between tabs and windows. A tab is an arrangement, so Cmd-1…9 switches whole arrangements.

This extends the existing two-pane split tabs instead of replacing them. All existing gestures still work, and the two-pane case behaves exactly as before.

## Decision

**B + C: each window is bound to one workspace and switches in place, and its content area holds VS Code-style editor groups side by side. A tab always shows exactly one view.**

The first version chose D (tabs holding nested split layouts). In use, split tabs made a tab mean two different things, and the reader beside its notes (the case D was meant for) is better served by a panel inside the reader's own tab. So D was replaced:

- Split tabs, pane headers, swap and the split badge are gone. A tab is one view.
- A reader's details and notes are a **panel in the reader's tab**, not a second view in the tab model (see below).
- Side-by-side work uses **editor groups** (C), horizontally only: each group has its own strip and active tab.

## Behaviour

### Windows and workspaces

- A window always has a workspace. Its sidebar, new notes and pages, imports, and the window title use that workspace.
- The workspace switcher, and **File › Switch Workspace** (Cmd-Shift-O), replace the window's workspace. The tabs being left are checked for unsaved changes, saved as that workspace's arrangement and closed. The target workspace's saved arrangement is then restored, or its Sources library opens if it has none.
- If another window already shows the target workspace, that window comes forward instead.
- Cmd-click or Option-click a workspace in the switcher, use its "open in new window" button, or use **File › Open Workspace in New Window** to open it in a separate window.
- **File › New Window** (Cmd-Shift-N) opens a window on the current workspace. Popping a tab out keeps its workspace, so several windows can share one workspace. Each window still shows only one.

### Editor groups

- **Split Right** (Cmd-\\, the strip's split button, the tab context menu) moves the tab into a new group to its group's right. A group's only tab stays, and the new group opens on a Home launcher instead: what it opens takes its place.
- **Drag** a tab to another group's strip to move it there (an insertion marker shows where), onto another group's content to move it into that group, or to the left or right third (at most 140 px) of any group's content to open a new group on that side. A translucent preview shows where it lands; native views are swapped for still frames meanwhile. Dragged out of the window, a tab tears off into a new window.
- **Sash.** Drag the sash between two groups to resize those two (never below 240 px); arrow keys move a focused sash; double-click (or **View › Equalize Group Widths**) makes all groups the same width. Native views follow once per frame while dragging.
- **Focus.** The focused group gets new tabs, Cmd-1…9, Cmd-Shift-[ / ] and Cmd-W. Clicking a group's strip or content focuses it; Cmd-Option-Left/Right moves focus between groups and Cmd-Option-Shift-Left/Right moves the tab into the neighbouring group (or a new one at the edge). Only the focused group's active tab is drawn at full strength.
- **Close.** Cmd-W closes the focused tab; closing a group's last tab closes the group and gives its width to its neighbour. **File › Close Group** (Cmd-Option-W) closes all of a group's tabs.
- **Open beside** (Option-click a link, ⌥↩) opens in the group to the right of the current one, creating it if needed. Search results open beside the search the same way.
- An already open document is focused in its group (and window) instead of being opened twice. Pinning, reordering, Close Other Tabs and Close Tabs to the Right act within a group.
- At most 6 groups.

### A reader's details and notes

- The reader's **Details & notes** button shows the source's page as a panel to the right of the PDF, inside the same tab. The sash between them resizes it (20–80 %, double-click resets).
- The panel's **Open in its own tab** button moves the page into a tab right after the reader's; **Details & notes** (or the page's **Read** button) docks it back, closing that tab. **Add to note** docks it too, unless the page is already visible in another group.
- The panel closes with the reader, moves with it between groups and windows, and is restored with it.

### Persistence

`window-state.json` in the user-data folder stores:

- each window's workspace, frame, sidebar width and groups;
- the arrangement last left behind in each workspace;
- a list of recently used workspaces, shown in the File menu.

Each group is saved with its share of the width, its active tab and its tabs; each tab as a view descriptor (Home; a content view; a PDF with its panel and the panel's share; or an Office file). Version 1 files, whose tabs held split layouts, are read too: each split tab comes back as its views, each a tab of its own, in its place.

The file is written shortly after every change and once more when quitting, before any window starts closing its tabs. At launch every saved window is restored on its workspace. Views that can no longer be resolved, such as deleted notes, are dropped. A window that ends up empty gets Home. `KEY_NO_WINDOW_RESTORE=1` starts without restoring, for tests that reuse a profile.

## Implementation map

- `src/shared/tab-model.ts`: `WorkspaceTabsState` (`groups`, `activeGroupId`; each group has `tabs`, `activeTabId`, `size`), pure operations (add, close, move, split into a new group, reorder, pin, sizes), and the geometry that main (native bounds) and the renderer (strips, DOM views, sashes, drop zones) share: `layoutGroups()`, `groupBody()`, `layoutPanel()`, `dragGroupSash()`.
- `src/main/window-state.ts`: reads (and migrates), validates and atomically writes the saved state.
- `src/main/index.ts`:
  - `nativeKinds` / `registerNativeKind()`: how each native tab kind (PDF, Office editors) creates and disposes its `WebContentsView`. Kinds not registered (`"home"`) are drawn by the shell renderer from `content`.
  - `add(record, w, { groupId?, index? })` opens any view as a tab (focused group by default); `focus(viewId)` shows an open one; `placeViews()` positions native views per group.
  - The reader panel: `OwnedView.panel`, `dockPanel()`, `closePanel()`, `popOutPanel()`.
  - Tab actions (`key:tab-action`): `split-right`, `drop-tab`, `focus-group`, `resize-groups`, `equalize-groups`, `panel-resize`, `panel-pop-out`, `panel-close`, plus the existing ones; the File and View menus.
- `src/renderer/App.tsx`: one strip per group, sashes, DOM views (and panels) placed per group, drop location.
- `src/renderer/TabBar.tsx`: one group's strip: reorder, drag to other groups or out of the window.

## Verification

- `smoke-tab-groups.cjs`: Split Right; native bounds against the sash (also mid-drag); double-click to equalize; focus and Cmd-1 per group; dragging between strips and to a group's side; a group closing with its last tab; an open document focused where it is; the reader panel, popping out and docking back; restoring groups, sizes and the panel after relaunch; reading a version 1 file.
- `smoke-tabs.cjs`: reorder without recreating views; native bounds with the sidebar collapsed and a moved sash; menu shortcuts; next tab and Close Other Tabs within a group.
- `smoke-source-page.cjs`: the source page as the reader's panel, its toggle in both directions.
- `smoke-mixed-tabs.cjs`: DOM and native groups side by side, unsaved drafts and close guards.
- `smoke-windows.cjs`: windows bound to a workspace; switching in place and back restores the groups; tear-off; restoring windows, frames and groups after relaunch.