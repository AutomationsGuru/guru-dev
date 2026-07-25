import type { ToolExecutePayload, ToolResultPayload } from "../extensions/events.js";

export interface PrePostToolBridge {
  readonly callLog: string[];
  onPre(callback: (payload: ToolExecutePayload) => void): void;
  onPost(callback: (payload: ToolResultPayload) => void): void;
  runTool(payload: ToolExecutePayload, toolImpl: (p: ToolExecutePayload) => ToolResultPayload): ToolResultPayload;
}

export function createPrePostToolBridge(): PrePostToolBridge {
  const callLog: string[] = [];
  const preCallbacks: Array<(payload: ToolExecutePayload) => void> = [];
  const postCallbacks: Array<(payload: ToolResultPayload) => void> = [];

  return {
    callLog,
    onPre(callback) {
      preCallbacks.push(callback);
    },
    onPost(callback) {
      postCallbacks.push(callback);
    },
    runTool(payload, toolImpl) {
      callLog.push("pre");
      for (const cb of preCallbacks) cb(payload);
      callLog.push("tool");
      const result = toolImpl(payload);
      callLog.push("post");
      for (const cb of postCallbacks) cb(result);
      return result;
    }
  };
}
