(async () => {
  await import("./server.mjs");
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
