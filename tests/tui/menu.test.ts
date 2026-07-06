import { createMenuState, enterDrill, menuReduce, refilter, selectedItem, type MenuItem } from "../../src/tui/menu.js";

const items: MenuItem[] = [
  { id: "/help", label: "/help" },
  { id: "/model", label: "/model", drillable: true },
  { id: "/resume", label: "/resume", drillable: true },
  { id: "/exit", label: "/exit" }
];

describe("slash menu state machine", () => {
  it("navigates with wrap-around", () => {
    let state = createMenuState(items, "/");
    expect(selectedItem(state)?.id).toBe("/help");
    state = menuReduce(state, { name: "down" }).state;
    expect(selectedItem(state)?.id).toBe("/model");
    state = menuReduce(state, { name: "up" }).state;
    state = menuReduce(state, { name: "up" }).state;
    expect(selectedItem(state)?.id).toBe("/exit"); // wrapped
    state = menuReduce(state, { name: "down" }).state;
    expect(selectedItem(state)?.id).toBe("/help"); // wrapped back
  });

  it("right drills only on drillable items", () => {
    let state = createMenuState(items, "/");
    expect(menuReduce(state, { name: "right" }).effect.kind).toBe("render"); // /help not drillable
    state = menuReduce(state, { name: "down" }).state; // /model
    const step = menuReduce(state, { name: "right" });
    expect(step.effect).toEqual({ kind: "drill", parentId: "/model" });
  });

  it("drill shows submenu items; enter-ids carry arguments; left returns", () => {
    const base = createMenuState(items, "/");
    const routes: MenuItem[] = [
      { id: "/model 1", label: "zai/glm-5-turbo" },
      { id: "/model 2", label: "sakana/fugu-ultra" }
    ];
    let state = enterDrill(base, "/model", routes);
    expect(state.mode).toBe("drill");
    state = menuReduce(state, { name: "down" }).state;
    expect(selectedItem(state)?.id).toBe("/model 2");
    const back = menuReduce(state, { name: "left" });
    expect(back.state.mode).toBe("commands");
  });

  it("tab accepts the selected item's id", () => {
    let state = createMenuState(items, "/mo");
    state = menuReduce(state, { name: "down" }).state;
    expect(menuReduce(state, { name: "tab" }).effect).toEqual({ kind: "accept", text: "/model" });
  });

  it("escape closes", () => {
    expect(menuReduce(createMenuState(items, "/"), { name: "escape" }).effect.kind).toBe("close");
  });

  it("refilter keeps the selection on the same item when it survives", () => {
    let state = createMenuState(items, "/");
    state = menuReduce(state, { name: "down" }).state; // /model
    const narrowed = refilter(state, [items[1]!, items[2]!], "/m");
    expect(selectedItem(narrowed)?.id).toBe("/model");
    const gone = refilter(narrowed, [items[0]!], "/h");
    expect(gone.selected).toBe(0);
  });

  it("empty item lists never crash navigation", () => {
    const state = createMenuState([], "/zzz");
    expect(menuReduce(state, { name: "down" }).state.selected).toBe(0);
    expect(menuReduce(state, { name: "tab" }).effect.kind).toBe("render");
  });
});
