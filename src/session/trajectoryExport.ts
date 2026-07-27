import * as fs from "node:fs";
import { scrubSecretValues } from "../safety/secretSafety.js";
import type { AgentSession } from "./agentSession.js";
import type { AgentToolEvent } from "../model/agentTurn.js";

export interface TrajectoryTurn {
  readonly turnId: number;
  readonly prompt: string;
  readonly assistant: string;
  readonly tools: readonly AgentToolEvent[];
  readonly durationMs: number;
  readonly steers: readonly string[];
}

export interface Trajectory {
  readonly turns: readonly TrajectoryTurn[];
  readonly exportedAt: string;
}

export class TrajectoryCollector {
  private readonly turns: TrajectoryTurn[] = [];
  private currentTurn: Partial<TrajectoryTurn> | null = null;
  private turnCounter = 0;

  attach(session: AgentSession): void {
    session.on("turn.start", (evt) => {
      this.turnCounter += 1;
      this.currentTurn = {
        turnId: this.turnCounter,
        prompt: evt.text,
        assistant: "",
        tools: [],
        steers: [],
        durationMs: 0
      };
    });

    session.on("steer.injected", (evt) => {
      if (this.currentTurn && Array.isArray(this.currentTurn.steers)) {
        this.currentTurn.steers.push(evt.text);
      }
    });

    session.on("tool.observation", (evt) => {
      if (this.currentTurn && Array.isArray(this.currentTurn.tools)) {
        this.currentTurn.tools.push(evt);
      }
    });

    session.on("turn.stop", (evt) => {
      if (this.currentTurn) {
        this.currentTurn.assistant = evt.text;
        this.currentTurn.durationMs = evt.durationMs;
        this.turns.push(this.currentTurn as TrajectoryTurn);
        this.currentTurn = null;
      }
    });
  }

  getTrajectory(): Trajectory {
    return {
      turns: this.turns,
      exportedAt: new Date().toISOString()
    };
  }
}

export function writeTrajectory(path: string, trajectory: Trajectory): void {
  const json = JSON.stringify(trajectory, null, 2);
  const scrubbed = scrubSecretValues(json);

  if (fs.existsSync(path)) {
    fs.renameSync(path, `${path}.bak`);
  }

  fs.writeFileSync(path, scrubbed, "utf8");
}
