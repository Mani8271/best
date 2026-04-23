(async () => {
  await import("./server.js");
})().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
