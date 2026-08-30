import process from "node:process";
import { dispatchNextOnDemandAgent } from "./onDemandAgentOps.js";

async function main(): Promise<void> {
  if (process.argv[2] !== "--dispatch") return;
  const bashMode = process.env.AGENT_LOOM_TASK_BASH_MODE === "off"
    ? "off"
    : process.env.AGENT_LOOM_TASK_BASH_MODE === "full" ? "full" : "safe";
  await dispatchNextOnDemandAgent(bashMode);
}

main().catch(() => process.exitCode = 1);
