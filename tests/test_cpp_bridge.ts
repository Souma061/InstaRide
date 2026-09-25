import { CppSpatialBridge } from "../src/spatial/cpp_spatial_bridge.js";

async function main() {
  console.log("==================================================");
  console.log("   Testing C++ Spatial Engine IPC Bridge from Node ");
  console.log("==================================================");

  const bridge = new CppSpatialBridge();
  const started = await bridge.start();

  if (!started) {
    console.error("❌ Failed to connect to C++ engine bridge.");
    process.exit(1);
  }

  console.log("✅ C++ engine bridge started and responded to PING");

  // Init region
  await bridge.initRegion({
    minLat: 12.86,
    maxLat: 13.06,
    minLng: 77.5,
    maxLng: 77.72,
  });
  console.log("✅ Region initialized");

  // Insert 3 test drivers
  await bridge.insert("driver_blr_1", 12.93, 77.61);
  await bridge.insert("driver_blr_2", 12.95, 77.64);
  await bridge.insert("driver_blr_3", 12.91, 77.59);
  console.log("✅ Inserted 3 test drivers into C++ Quadtree");

  // Test fire-and-forget single update
  bridge.update("driver_blr_1", 12.932, 77.612);
  console.log("✅ Fire-and-forget single update sent");

  // Test fire-and-forget batch update
  bridge.batchUpdate([
    { id: "driver_blr_2", lat: 12.90, lng: 77.60 },
    { id: "driver_blr_3", lat: 12.92, lng: 77.62 },
  ]);
  console.log("✅ Fire-and-forget batch update sent");

  // Query k-NN
  const result = await bridge.kNearestNeighbors(12.935, 77.615, 2, 10000);
  console.log(
    `✅ k-NN Query returned in ${result.latencyUs.toFixed(2)} microseconds!`,
  );
  console.log("Candidates found:", result.candidates);

  if (result.candidates.length !== 2) {
    console.error("❌ Expected 2 candidates, got:", result.candidates.length);
    bridge.stop();
    process.exit(1);
  }

  bridge.stop();
  console.log("✅ C++ Bridge cleanly stopped. Test PASSED!");
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
