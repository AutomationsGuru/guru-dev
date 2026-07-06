/**
 * Interactive slash-menu state machine (pure — the ANSI/readline glue lives in guru).
 * Claude-Code-style behavior: menu opens on "/", filters as you type, ↑/↓ navigate,
 * → drills into a command's options (e.g. /model → route list), ← returns, Esc
 * closes, Tab accepts the selection into the input line, Enter executes it.
 */

export interface MenuItem {
  /** The line to execute (or complete to) when chosen, e.g. "/model" or "/model 3". */
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Right-arrow opens a submenu for this item. */
  readonly drillable?: boolean;
}

export interface MenuState {
  readonly mode: "commands" | "drill";
  /** Command that was drilled into (drill mode only), e.g. "/model". */
  readonly parentId?: string;
  readonly items: readonly MenuItem[];
  readonly selected: number;
  /** The user's typed input line (commands mode filters against this). */
  readonly buffer: string;
}

export type MenuKey =
  | { name: "up" }
  | { name: "down" }
  | { name: "right" }
  | { name: "left" }
  | { name: "escape" }
  | { name: "tab" };

export type MenuEffect =
  | { kind: "render" }
  | { kind: "close" }
  | { kind: "drill"; parentId: string }
  | { kind: "accept"; text: string };

export interface MenuStep {
  readonly state: MenuState;
  readonly effect: MenuEffect;
}

export function createMenuState(items: readonly MenuItem[], buffer: string): MenuState {
  return { mode: "commands", items, selected: 0, buffer };
}

export function enterDrill(state: MenuState, parentId: string, items: readonly MenuItem[]): MenuState {
  return { mode: "drill", parentId, items, selected: 0, buffer: state.buffer };
}

/** Re-filter (commands mode) after typing; keeps selection on the same item when possible. */
export function refilter(state: MenuState, items: readonly MenuItem[], buffer: string): MenuState {
  const previous = state.items[state.selected]?.id;
  const kept = items.findIndex((item) => item.id === previous);

  return { ...state, mode: "commands", items, selected: kept >= 0 ? kept : 0, buffer };
}

export function selectedItem(state: MenuState): MenuItem | undefined {
  return state.items[state.selected];
}

export function menuReduce(state: MenuState, key: MenuKey): MenuStep {
  const count = state.items.length;
  switch (key.name) {
    case "up":
      return { state: { ...state, selected: count === 0 ? 0 : (state.selected - 1 + count) % count }, effect: { kind: "render" } };
    case "down":
      return { state: { ...state, selected: count === 0 ? 0 : (state.selected + 1) % count }, effect: { kind: "render" } };
    case "right": {
      const item = selectedItem(state);
      if (state.mode === "commands" && item?.drillable) {
        return { state, effect: { kind: "drill", parentId: item.id } };
      }
      return { state, effect: { kind: "render" } };
    }
    case "left":
      if (state.mode === "drill") {
        return { state: { ...state, mode: "commands" }, effect: { kind: "drill", parentId: "" } };
      }
      return { state, effect: { kind: "render" } };
    case "escape":
      return { state, effect: { kind: "close" } };
    case "tab": {
      const item = selectedItem(state);
      return { state, effect: item ? { kind: "accept", text: item.id } : { kind: "render" } };
    }
  }
}
