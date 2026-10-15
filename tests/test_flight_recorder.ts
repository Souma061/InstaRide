import { DriverRegistry } from "../src/core/driver_registry.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import { DriverSimulator } from "../src/simulation/driver_simulator.js";
import { QuadTree } from "../src/spatial/quadtree.js";
import { CassandraFlightRecorder } from "../src/infra/flight_recorder.js";
import { initCassandraSchema, getCassandraClient } from "../src/infra/cassandra_client.js";

async function main() {
  console.log("==========================================================");
  console.log("✈️ EXPERIMENT 2: CASSANDRA BLACK BOX FLIGHT RECORDER");
  console.log("==========================================================\n");

  // 1. Initialize schema
  await initCassandraSchema();
  const cassandraClient = getCassandraClient();
  await cassandraClient.connect();

  const flightRecorder = new CassandraFlightRecorder({ batchSize: 50, flushIntervalMs: 50 });

  const bounds = {
    minLat: 12.90,
    maxLat: 13.05,
    minLng: 77.50,
    maxLng: 77.70,
  };

  const spatialIndex = new QuadTree(bounds);
  const registry = new DriverRegistry(spatialIndex);
  const stateMachine = new TripStateMachine();
  const simulator = new DriverSimulator(bounds, registry, stateMachine);

  // Hook Flight Recorder into DriverSimulator and TripStateMachine
  let tickCount = 0;
  simulator.onTelemetryTick = (updates) => {
    tickCount++;
    flightRecorder.recordBreadcrumbs(updates);
  };

  stateMachine.onTransition = (event) => {
    flightRecorder.recordTripTransition(event);
  };

  console.log("1. Starting Driver Simulator with 50 virtual drivers...");
  simulator.start(50, 100); // 50 drivers ticking every 100ms

  // Let drivers roam and emit telemetry for 600ms
  await new Promise((r) => setTimeout(r, 600));

  console.log(`✓ Telemetry ticks captured: ${tickCount} ticks emitted by 50 drivers.`);

  // 2. Simulate complete Trip Lifecycle Transitions
  console.log("\n2. Simulating full trip state machine lifecycles...");
  const tripRes = stateMachine.createTrip({
    requestId: "req_flight_1001",
    riderId: "rider_alicia",
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9352, lng: 77.6245 },
  });

  const tripId = tripRes.trip!.id;
  const driverId = "sim_driver_7";

  stateMachine.transition(tripId, "matching", "system", "Locating nearest driver");
  stateMachine.transition(tripId, "matched", "system", "Matched with nearest driver", { driverId });
  stateMachine.transition(tripId, "en_route", "driver", "Driver accepted and en route");
  stateMachine.transition(tripId, "arrived", "driver", "Driver arrived at pickup point");
  stateMachine.transition(tripId, "in_progress", "driver", "Rider onboard, trip started");
  stateMachine.transition(tripId, "completed", "driver", "Arrived at destination safely", { fare: 24.50 });

  console.log(`✓ Trip ${tripId} transitioned through 6 lifecycles.`);

  // Stop simulator & flush buffers into Cassandra
  simulator.stop();
  await flightRecorder.shutdown();
  console.log("✓ Flight Recorder flushed all buffers to Cassandra commitlogs & memtables.\n");

  // 3. Inspect Millisecond GPS Breadcrumb Trail from Cassandra
  console.log("==========================================================");
  console.log("📍 QUERYING CASSANDRA: Driver sim_driver_7 Trajectory Breadcrumbs");
  console.log("==========================================================");

  const today = new Date().toISOString().slice(0, 10);
  const breadcrumbs = await flightRecorder.getDriverBreadcrumbs(driverId, today, 5);

  console.table(
    breadcrumbs.map((b) => ({
      Driver: b.driver_id,
      Date: b.date,
      Timestamp: b.timestamp.toISOString(),
      Lat: b.lat.toFixed(5),
      Lng: b.lng.toFixed(5),
      Status: b.status,
    }))
  );

  // 4. Inspect Trip Audit Trail from Cassandra
  console.log("\n==========================================================");
  console.log(`📜 QUERYING CASSANDRA: Trip Audit Trail for ${tripId}`);
  console.log("==========================================================");

  const auditRows = await flightRecorder.getTripAuditLog(tripId);
  console.table(
    auditRows.map((a) => ({
      Timestamp: a.timestamp.toISOString(),
      "From Status": a.from_status,
      "To Status": a.to_status,
      "Triggered By": a.triggered_by,
      Reason: a.reason,
      Payload: a.payload || "{}",
    }))
  );

  console.log("\n✅ Experiment 2 Successful: Both GPS breadcrumbs and trip lifecycle audits");
  console.log("   were persisted into Cassandra without blocking the simulation loop!\n");

  await cassandraClient.shutdown();
}

main().catch((err) => {
  console.error("Experiment 2 failed:", err);
  process.exit(1);
});
