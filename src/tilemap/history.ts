import type { TileMap } from "./model";

interface History {
  past: TileMap[];
  present: TileMap;
  future: TileMap[];
  strokeStart: TileMap | null;
}

export type Edit = (map: TileMap) => TileMap;

export type Action =
  | { type: "reset"; map: TileMap }
  | { type: "edit" | "stroke"; apply: Edit }
  | { type: "finish" | "undo" | "redo" };

export function makeHistory(map: TileMap): History {
  return { past: [], present: map, future: [], strokeStart: null };
}

function checkpoint(history: History, before: TileMap, present: TileMap): History {
  return { past: [...history.past.slice(-39), before], present, future: [], strokeStart: null };
}

export function changeHistory(state: History, action: Action): History {
  if (action.type === "reset") return makeHistory(action.map);
  if (action.type === "stroke") {
    const present = action.apply(state.present);
    return present === state.present ? state : { ...state, present, strokeStart: state.strokeStart ?? state.present };
  }
  const history = state.strokeStart ? checkpoint(state, state.strokeStart, state.present) : state;
  if (action.type === "edit") {
    const present = action.apply(history.present);
    return present === history.present ? history : checkpoint(history, history.present, present);
  }
  if (action.type === "undo" && history.past.length) {
    return {
      past: history.past.slice(0, -1), present: history.past[history.past.length - 1],
      future: [history.present, ...history.future], strokeStart: null,
    };
  }
  if (action.type === "redo" && history.future.length) {
    return {
      past: [...history.past, history.present], present: history.future[0],
      future: history.future.slice(1), strokeStart: null,
    };
  }
  return history;
}
