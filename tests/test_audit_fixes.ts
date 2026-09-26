import fs from "node:fs";
import path from "node:path";
import { CppSpatialBridge } from "../src/spatial/cpp_spatial_bridge.js";
import { DriverRegistry } from "../src/core/driver_registry.js";
import { MatchingService } from "../src/core/matching_service.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import { WsManager } from "../src/gateway/ws_manager.js";
import { QuadTree } from "../src/spatial/quadtree.js";
import { clampTimeout } from "../src/utils/validation.js";

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

console.log(
  "======================================================================",
);
console.log(
  "             VERIFYING AUDIT FIXES & CONCURRENCY GUARDS               ",
);
console.log(
  "======================================================================\n",
);

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName}${detail ? ` -> ${detail}` : ""}`);
    failed++;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function countQuadNodes(node: any): number {
  if (!node) return 0;
  return (
    1 +
    countQuadNodes(node.nw) +
    countQuadNodes(node.ne) +
    countQuadNodes(node.sw) +
    countQuadNodes(node.se)
  );
}

// Mock WebSocket class for unit-testing WsManager message handling
class MockSocket {
  public sentMessages: any[] = [];
  public readyState = 1; // WebSocket.OPEN
  private listeners: Map<string, Function[]> = new Map();

  public on(event: string, fn: Function) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(fn);
  }

  public send(payload: string) {
    try {
      this.sentMessages.push(JSON.parse(payload));
    } catch {
      this.sentMessages.push(payload);
    }
  }

  public emit(event: string, data?: any) {
    const list = this.listeners.get(event) || [];
    for (const fn of list) fn(data);
  }

  public close() {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit("close");
  }

  public getLastMessage() {
    return this.sentMessages[this.sentMessages.length - 1];
  }
}

async function runAuditFixTests() {
  // 1. Critical: Accept/Cancel Race Condition (Driver Never Stranded as Busy)
  console.log("[1. Critical: Accept/Cancel Race Condition & Rollback]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const matching = new MatchingService(registry, sm);

    registry.registerDriver("driver_race", 37.7749, -122.4194, "available");
    assert(tree.size() === 1, "Driver initially indexed in QuadTree");

    await matching.requestRide({
      requestId: "req_race_1",
      riderId: "rider_race_1",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
      offerTimeoutMs: 1000,
    });

    await sleep(20);

    // Driver accepts offer
    matching.handleDriverResponse("driver_race", "req_race_1", "accepted");

    // Immediately simulate concurrent rider cancellation
    matching.cancelRide(
      "req_race_1",
      "rider",
      "Cancelled right at accept boundary",
    );

    await sleep(50);

    const trip = sm.getTripByRequestId("req_race_1");
    const driver = registry.getDriver("driver_race");

    assert(trip?.status === "cancelled", "Trip status is safely cancelled");
    assert(
      driver?.status === "available",
      "Driver status is available (NOT stranded as busy)",
    );
    assert(driver?.lockToken === undefined, "Driver lockToken is cleared");
    assert(tree.size() === 1, "Driver successfully re-indexed into QuadTree");
  }

  // 2. Critical: WebSocket Role Gating & Ownership Authorization
  console.log(
    "\n[2. Critical: WebSocket Role Gating & Ownership Authorization]",
  );
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const wsManager = new WsManager(registry, sm);
    const matching = new MatchingService(registry, sm);
    wsManager.setMatchingService(matching);

    // Setup: Rider Alice has an active trip
    const tripAlice = sm.createTrip({
      requestId: "req_alice",
      riderId: "rider_alice",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
    });
    sm.startMatching(tripAlice.trip!.id);

    // Scenario A: Observer socket attempts to cancel Alice's ride
    const observerSocket = new MockSocket();
    wsManager.handleConnection(observerSocket as any, "observer", "observer_1");

    observerSocket.emit(
      "message",
      JSON.stringify({
        type: "cancel_ride",
        requestId: "req_alice",
      }),
    );

    const obsResponse = observerSocket.getLastMessage();
    assert(
      obsResponse.type === "error" &&
        obsResponse.message.includes("Unauthorized"),
      "Observer cannot cancel ride (role-gated)",
    );

    // Scenario B: Rider Bob attempts to cancel Alice's ride (impersonation / cross-trip tampering)
    const bobSocket = new MockSocket();
    wsManager.handleConnection(bobSocket as any, "rider", "rider_bob");

    bobSocket.emit(
      "message",
      JSON.stringify({
        type: "cancel_ride",
        requestId: "req_alice",
      }),
    );

    const bobResponse = bobSocket.getLastMessage();
    assert(
      bobResponse.type === "error" &&
        bobResponse.message.includes("does not belong to this rider"),
      "Rider Bob cannot cancel Alice's ride (ownership-authorized)",
    );

    // Scenario C: Driver Charlie attempts to complete a trip assigned to Driver Dave
    registry.registerDriver("driver_dave", 37.7749, -122.4194, "available");
    sm.setMatched(tripAlice.trip!.id, "driver_dave");

    const charlieSocket = new MockSocket();
    wsManager.handleConnection(
      charlieSocket as any,
      "driver",
      "driver_charlie",
    );

    charlieSocket.emit(
      "message",
      JSON.stringify({
        type: "driver_action",
        action: "complete_trip",
        tripId: tripAlice.trip!.id,
      }),
    );

    const charlieResponse = charlieSocket.getLastMessage();
    assert(
      charlieResponse.type === "error" &&
        charlieResponse.message.includes("not assigned to this trip"),
      "Driver Charlie cannot control Driver Dave's trip (driver-authorized)",
    );
  }

  // 3. High: Real WebSocket Driver Auto-Registration
  console.log("\n[3. High: Real WebSocket Driver Auto-Registration]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const wsManager = new WsManager(registry, sm);
    const matching = new MatchingService(registry, sm);
    wsManager.setMatchingService(matching);

    // Real driver connects over WebSocket (never registered in registry before)
    const realDriverSocket = new MockSocket();
    wsManager.handleConnection(
      realDriverSocket as any,
      "driver",
      "real_driver_99",
    );

    assert(
      registry.getDriver("real_driver_99") === undefined,
      "Driver initially unregistered",
    );

    // Driver sends first telemetry ping
    realDriverSocket.emit(
      "message",
      JSON.stringify({
        type: "driver_telemetry",
        lat: 37.7749,
        lng: -122.4194,
      }),
    );

    const driverRecord = registry.getDriver("real_driver_99");
    assert(
      driverRecord !== undefined,
      "Real WebSocket driver auto-registered in DriverRegistry",
    );
    assert(driverRecord?.status === "available", "Driver status is available");
    assert(
      tree.size() === 1,
      "Driver is indexed in QuadTree and discoverable by k-NN",
    );

    // Driver disconnects
    realDriverSocket.close();
    assert(
      registry.getDriver("real_driver_99")?.status === "offline",
      "Disconnected driver marked offline",
    );
    assert(tree.size() === 0, "Disconnected driver removed from QuadTree");
  }

  // 4. Medium: Stale Driver Eviction
  console.log("\n[4. Medium: Stale Driver Eviction]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);

    const d = registry.registerDriver(
      "stale_driver_1",
      37.7749,
      -122.4194,
      "available",
    );
    // Artificially age lastSeen by 35 seconds
    d.lastSeen = Date.now() - 35_000;

    assert(tree.size() === 1, "Driver in QuadTree before eviction");
    const evicted = registry.evictStaleDrivers(30_000);

    assert(
      evicted.includes("stale_driver_1"),
      "Stale driver evicted by timeout",
    );
    assert(d.status === "offline", "Evicted driver status set to offline");
    assert(tree.size() === 0, "Evicted driver pulled from QuadTree");
  }

  // 5. Medium: Finite Coordinates & Bounded Timing Validation
  console.log("\n[5. Medium: Finite Coordinates & Bounded Timing Validation]");
  {
    const sm = new TripStateMachine();

    // Out-of-bounds latitude
    const resLat = sm.createTrip({
      requestId: "req_invalid_1",
      riderId: "rider_1",
      pickup: { lat: 999, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
    });
    assert(
      !resLat.success && resLat.error?.includes("Invalid coordinates"),
      "Latitude 999 rejected",
    );

    // NaN / Infinity coordinates
    const resNaN = sm.createTrip({
      requestId: "req_invalid_2",
      riderId: "rider_2",
      pickup: { lat: NaN, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
    });
    assert(!resNaN.success, "NaN coordinate rejected");

    // Timing bounds clamping
    assert(
      clampTimeout(-500) === 15000,
      "Negative timeout clamps to default 15,000ms",
    );
    assert(
      clampTimeout(999999) === 60000,
      "Huge timeout clamps to maximum 60,000ms",
    );
    assert(
      clampTimeout(200) === 1000,
      "Tiny timeout clamps to minimum 1,000ms",
    );
    assert(clampTimeout(5000) === 5000, "Valid 5,000ms timeout preserved");
  }

  // 6. Regression: Replaced sockets and spatial-index recovery
  console.log("\n[6. Regression: Reconnection & Spatial Index Recovery]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const wsManager = new WsManager(registry, sm);
    wsManager.setMatchingService(new MatchingService(registry, sm));

    const firstSocket = new MockSocket();
    wsManager.handleConnection(firstSocket as any, "driver", "driver_reconnect");
    firstSocket.emit(
      "message",
      JSON.stringify({ type: "driver_telemetry", lat: 37.7749, lng: -122.4194 }),
    );

    const replacementSocket = new MockSocket();
    wsManager.handleConnection(
      replacementSocket as any,
      "driver",
      "driver_reconnect",
    );
    firstSocket.close();
    assert(
      registry.getDriver("driver_reconnect")?.status === "available",
      "Old socket close does not offline a replacement connection",
    );

    tree.remove("driver_reconnect");
    replacementSocket.emit(
      "message",
      JSON.stringify({ type: "driver_telemetry", lat: 37.775, lng: -122.419 }),
    );
    assert(tree.size() === 1, "Valid telemetry restores a missing spatial entry");

    const outside = registry.registerDriver("outside_region", 40, -122.4194, "available");
    assert(
      outside.status === "offline" && tree.size() === 1,
      "Out-of-region driver is never advertised as available",
    );
  }

  // 7. Regression: malformed HTTP-style response cannot consume a lease
  console.log("\n[7. Regression: Offer Response Validation]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const matching = new MatchingService(registry, sm);
    registry.registerDriver("driver_offer", 37.7749, -122.4194, "available");

    await matching.requestRide({
      requestId: "req_invalid_response",
      riderId: "rider_invalid_response",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
      offerTimeoutMs: 1000,
    });
    await sleep(10);

    const response = matching.handleDriverResponse(
      "driver_offer",
      "req_invalid_response",
      "not-a-response",
    );
    assert(
      !response.success && response.error?.includes("INVALID_RESPONSE"),
      "Invalid response is rejected without resolving the active offer",
    );
    assert(
      matching.getActiveOffer("req_invalid_response") !== undefined,
      "Invalid response leaves the valid lease under normal timeout control",
    );
    matching.cancelRide("req_invalid_response");
  }

  // 8. Regression: C++ IPC bridge guards (audit C-1, C-2, H-1)
  console.log("\n[8. Regression: C++ IPC Bridge Guards]");
  {
    assert(
      CppSpatialBridge.isValidId("driver_1") === true,
      "C-1: valid id accepted",
    );
    for (const bad of ["", "driver 1", 'evil"quote', "a\nb", "x/y", "a\\b"]) {
      assert(
        CppSpatialBridge.isValidId(bad) === false,
        `C-1: malformed id rejected -> ${JSON.stringify(bad)}`,
      );
    }

    const binaryPath = path.resolve(
      process.cwd(),
      "cpp-engine",
      "engine_bridge.exe",
    );
    if (!fs.existsSync(binaryPath)) {
      console.log(
        `  - SKIP: ${binaryPath} not built (run pnpm build:cpp) — IPC cases not exercised`,
      );
    } else {
      const bridge = new CppSpatialBridge(binaryPath);
      const started = await bridge.start();
      assert(started, "C-2: bridge starts and answers PING");

      if (started) {
        // C-2: an id containing '"' makes the C++ side emit invalid JSON.
        // The pending promise must settle with JSON_PARSE_ERROR, not hang.
        const sendRaw = (cmd: string) =>
          (bridge as any).sendCommand(cmd) as Promise<any>;
        const malformed = await withTimeout(
          sendRaw('INSERT evil" 12.97 77.59'),
          2000,
          "parse-error response",
        );
        assert(
          malformed.status === "error" &&
            String(malformed.error).startsWith("JSON_PARSE_ERROR"),
          "C-2: malformed C++ output rejects the pending promise",
          JSON.stringify(malformed),
        );

        // C-2 fallout: the queue must still be aligned for the next command.
        const afterParseError = await withTimeout(
          sendRaw("PING"),
          2000,
          "post-parse-error PING",
        );
        assert(
          afterParseError.msg === "PONG",
          "C-2: pending queue stays aligned after a parse error",
          JSON.stringify(afterParseError),
        );

        // H-1: UPDATE is fire-and-forget in C++, so this resolver never
        // fires on its own — only draining on stop() can settle it.
        const orphan = sendRaw("UPDATE orphan_driver 12.97 77.59");
        bridge.stop();
        const drained = await withTimeout(orphan, 2000, "drain on stop");
        assert(
          drained.status === "error",
          "H-1: pending promises are drained when the engine stops",
          JSON.stringify(drained),
        );
      }
    }
  }

  // 9. Regression: QuadTree collapses empty subtrees (audit H-4)
  console.log("\n[9. Regression: QuadTree Node Collapse]");
  {
    const tree = new QuadTree({ ...SF_BOUNDS, maxLat: 37.72 }, 2, 6);
    const baseLat = 37.71;
    const baseLng = -122.46;
    for (let i = 0; i < 4; i++) {
      tree.insert(`collapse_${i}`, baseLat + i * 0.00001, baseLng + i * 0.00001);
    }
    assert(
      tree.root.isDivided && countQuadNodes(tree.root) > 1,
      "Tree subdivides once capacity is exceeded",
      `nodes=${countQuadNodes(tree.root)}`,
    );

    for (let i = 0; i < 4; i++) {
      tree.remove(`collapse_${i}`);
    }
    assert(tree.size() === 0, "All points removed");
    assert(
      tree.root.isDivided === false,
      "H-4: empty root collapses back to a leaf",
      `nodes=${countQuadNodes(tree.root)}`,
    );
    assert(
      countQuadNodes(tree.root) === 1,
      "H-4: child nodes are reclaimed, not retained as empty husks",
      `nodes=${countQuadNodes(tree.root)}`,
    );
  }

  // 10. Regression: auto-generated requestIds are collision-safe (audit M-1)
  console.log("\n[10. Regression: RequestId Collision Safety]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const wsManager = new WsManager(registry, sm);
    const captured: string[] = [];
    wsManager.setMatchingService({
      requestRide: async (params: { requestId: string }) => {
        captured.push(params.requestId);
        return { success: false, error: "stub" };
      },
    } as any);

    const UUID_RE =
      /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const rider of ["rider_m1_a", "rider_m1_b", "rider_m1_c"]) {
      const socket = new MockSocket();
      wsManager.handleConnection(socket as any, "rider", rider);
      socket.emit(
        "message",
        JSON.stringify({
          type: "ride_request",
          pickup: { lat: 37.7749, lng: -122.4194 },
          dropoff: { lat: 37.785, lng: -122.415 },
        }),
      );
    }
    await sleep(20);

    assert(captured.length === 3, "Three ride requests captured", `got=${captured.length}`);
    assert(
      captured.every((id) => UUID_RE.test(id)),
      "M-1: generated requestIds are UUID-based",
      JSON.stringify(captured),
    );
    assert(
      new Set(captured).size === captured.length,
      "M-1: concurrent requests never collide on requestId",
      JSON.stringify(captured),
    );
  }

  // 11. Regression: abortedRequests is bounded (audit H-7)
  console.log("\n[11. Regression: abortedRequests Does Not Grow]");
  {
    const tree = new QuadTree(SF_BOUNDS);
    const registry = new DriverRegistry(tree);
    const sm = new TripStateMachine();
    const matching = new MatchingService(registry, sm);
    const abortedSize = () => (matching as any).abortedRequests.size as number;

    registry.registerDriver("driver_h7", 37.7749, -122.4194, "available");

    for (let i = 0; i < 5; i++) {
      const requestId = `req_h7_${i}`;
      await matching.requestRide({
        requestId,
        riderId: `rider_h7_${i}`,
        pickup: { lat: 37.7749, lng: -122.4194 },
        dropoff: { lat: 37.785, lng: -122.415 },
        offerTimeoutMs: 1000,
      });
      await sleep(20);
      await matching.cancelRide(requestId, "rider", "regression probe");
      await sleep(30);
      registry.registerDriver(
        `driver_h7_${i}`,
        37.7749 + i * 0.001,
        -122.4194,
        "available",
      );
    }

    assert(
      abortedSize() === 0,
      "H-7: abortedRequests is emptied once each offer loop finishes",
      `size=${abortedSize()}`,
    );
  }

  // 12. Regression: completed trips are evicted (audit H-8)
  console.log("\n[12. Regression: Trip Map Eviction]");
  {
    const sm = new TripStateMachine();
    const trips = (sm as any).trips as Map<string, unknown>;
    const firstTripId = sm.createTrip({
      requestId: "req_h8_0",
      riderId: "rider_h8",
      pickup: { lat: 37.7749, lng: -122.4194 },
      dropoff: { lat: 37.785, lng: -122.415 },
    }).trip!.id;
    sm.cancelTrip(firstTripId, "rider", "warmup");

    for (let i = 1; i <= 10_050; i++) {
      const created = sm.createTrip({
        requestId: `req_h8_${i}`,
        riderId: "rider_h8",
        pickup: { lat: 37.7749, lng: -122.4194 },
        dropoff: { lat: 37.785, lng: -122.415 },
      });
      if (created.trip) {
        sm.cancelTrip(created.trip.id, "rider", "churn");
      }
    }

    assert(
      trips.size <= 10_050,
      "H-8: trips map stays near its capacity ceiling",
      `size=${trips.size}`,
    );
    assert(
      sm.getTrip(firstTripId) === undefined,
      "H-8: oldest terminal trip is evicted instead of retained forever",
      `size=${trips.size}`,
    );
  }

  console.log(
    "\n======================================================================",
  );
  console.log(`SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log(
    "======================================================================",
  );

  if (failed > 0) {
    process.exit(1);
  }
}

runAuditFixTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
