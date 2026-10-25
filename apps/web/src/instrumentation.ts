export async function register() {
  // the condition must wrap the import so the edge bundle drops the Node-only worker
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startNodeServices } = await import("./instrumentation-node");
    startNodeServices();
  }
}
