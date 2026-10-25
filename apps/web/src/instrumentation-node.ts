import { startJobWorker } from "./server/jobs/worker";

export function startNodeServices() {
  if (process.env.JOB_WORKER_ENABLED === "false") return;
  // skip during `next build` page-data collection
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  startJobWorker();
}
