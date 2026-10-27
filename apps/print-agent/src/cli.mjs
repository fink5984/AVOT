#!/usr/bin/env node
import { PrintAgent, AGENT_VERSION, defaultConfigDir } from "./agent.mjs";

const [cmd = "run", ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const agent = new PrintAgent();
const log = console;

async function main() {
  if (cmd === "pair") {
    const server = flag("server");
    const code = flag("code");
    if (!server || !/^\d{8}$/.test(code ?? "")) {
      log.error("שימוש: avot-print-agent pair --server https://<האתר> --code <8 ספרות> [--name <שם>]");
      process.exit(2);
    }
    const cfg = await agent.pair({ server, code, name: flag("name") });
    log.log(`הסוכן צומד בהצלחה לשרת ${cfg.server} (${cfg.name}). הפעלה: avot-print-agent run`);
    return;
  }
  if (cmd === "status") {
    const cfg = await agent.load();
    log.log(cfg ? `מצומד לשרת ${cfg.server} · גרסה ${AGENT_VERSION} · תיקיית נתונים ${defaultConfigDir()}` : "לא מצומד");
    return;
  }
  if (cmd === "run") {
    if (!(await agent.load())) {
      log.error("הסוכן אינו מצומד. הריצו: avot-print-agent pair --server <כתובת האתר> --code <קוד>");
      process.exit(2);
    }
    process.on("SIGINT", () => agent.stop());
    process.on("SIGTERM", () => agent.stop());
    log.log(`סוכן ההדפסה פועל (גרסה ${AGENT_VERSION}) מול ${agent.config.server}`);
    await agent.run();
    return;
  }
  log.error("פקודות: pair | run | status");
  process.exit(2);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
