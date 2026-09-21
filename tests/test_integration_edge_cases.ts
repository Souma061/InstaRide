import { DriverRegistry } from "../src/core/driver_registry.js";
import { MatchingService } from "../src/core/matching_service.js";
import { TripStateMachine } from "../src/core/trip_state_machine.js";
import { WsManager } from "../src/gateway/ws_manager.js";
import { QuadTree } from "../src/spatial/quadtree.js";

const BOUNDS = {
  minLat: 37.70,
  maxLat: 37.85,
  minLng: -122.55,
  maxLng: -122.35,
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOffer(
  matching: MatchingService,
  requestId: string,
): Promise<NonNullable<ReturnType<MatchingService["getActiveOffer"]>>> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const offer = matching.getActiveOffer(requestId);
    if (offer) return offer;
    await sleep(5);
  }
  throw new Error(`Timed out waiting for offer ${requestId}`);
}

class MockSocket {
  public readyState = 1;
  public readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Array<(value?: any) => void>>();

  public on(event: string, listener: (value?: any) => void): void {
    const registered = this.listeners.get(event) ?? [];
    registered.push(listener);
    this.listeners.set(event, registered);
  }

  public send(payload: string): void {
    this.messages.push(JSON.parse(payload));
  }

  public emit(event: string, value?: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

async function run(): Promise<void> {
  console.log("\nIntegration edge-case coverage\n");

  console.log("[1] Reset resolves offers and leaves the matcher reusable");
  {
    const tree = new QuadTree(BOUNDS);
    const registry = new DriverRegistry(tree);
    const stateMachine = new TripStateMachine();
    const matching = new MatchingService(registry, stateMachine);
    registry.registerDriver("driver_a", 37.775, -122.42, "available");
    registry.registerDriver("driver_b", 37.78, -122.42, "available");

    await matching.requestRide({
      requestId: "reset_pending",
      riderId: "rider_reset",
      pickup: { lat: 37.775, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.41 },
      offerTimeoutMs: 1_000,
    });
    await waitForOffer(matching, "reset_pending");

    matching.reset("integration reset");
    await sleep(0);

    assert(
      stateMachine.getTripByRequestId("reset_pending")?.status === "cancelled",
      "reset cancels an in-flight matching trip",
    );
    assert(
      matching.getActiveOffer("reset_pending") === undefined,
      "reset clears the pending offer timer and record",
    );
    assert(tree.size() === 2, "reset releases the leased driver back to the index");

    await matching.requestRide({
      requestId: "reset_afterward",
      riderId: "rider_after_reset",
      pickup: { lat: 37.775, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.41 },
      offerTimeoutMs: 1_000,
    });
    const newOffer = await waitForOffer(matching, "reset_afterward");
    matching.handleDriverResponse(newOffer.driverId, "reset_afterward", "accepted");
    await sleep(0);
    assert(
      stateMachine.getTripByRequestId("reset_afterward")?.status === "matched",
      "the same matcher processes a new trip after reset",
    );
  }

  console.log("\n[2] Accept/cancel ordering never strands a driver");
  {
    const tree = new QuadTree(BOUNDS);
    const registry = new DriverRegistry(tree);
    const stateMachine = new TripStateMachine();
    const matching = new MatchingService(registry, stateMachine);
    registry.registerDriver("driver_race", 37.775, -122.42, "available");

    await matching.requestRide({
      requestId: "accept_cancel",
      riderId: "rider_race",
      pickup: { lat: 37.775, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.41 },
      offerTimeoutMs: 1_000,
    });
    const offer = await waitForOffer(matching, "accept_cancel");
    matching.handleDriverResponse(offer.driverId, "accept_cancel", "accepted");
    matching.cancelRide("accept_cancel", "rider", "cancelled at accept boundary");
    await sleep(0);

    assert(
      stateMachine.getTripByRequestId("accept_cancel")?.status === "cancelled",
      "cancellation wins when it follows offer acceptance in the same turn",
    );
    assert(
      registry.getDriver("driver_race")?.status === "available" && tree.size() === 1,
      "the cancelled offer driver is available and re-indexed",
    );
  }

  console.log("\n[3] Reconnect and invalid telemetry preserve registry correctness");
  {
    const tree = new QuadTree(BOUNDS);
    const registry = new DriverRegistry(tree);
    const stateMachine = new TripStateMachine();
    const wsManager = new WsManager(registry, stateMachine);
    wsManager.setMatchingService(new MatchingService(registry, stateMachine));

    const original = new MockSocket();
    wsManager.handleConnection(original as any, "driver", "driver_socket");
    original.emit("message", JSON.stringify({ type: "driver_telemetry", lat: 37.775, lng: -122.42 }));

    const replacement = new MockSocket();
    wsManager.handleConnection(replacement as any, "driver", "driver_socket");
    original.close();
    assert(
      registry.getDriver("driver_socket")?.status === "available",
      "an old socket close cannot offline the replacement connection",
    );

    replacement.emit("message", JSON.stringify({ type: "driver_telemetry", lat: 40, lng: -122.42 }));
    const lastMessage = replacement.messages.at(-1) as { type?: string; message?: string };
    assert(
      lastMessage.type === "error" && lastMessage.message?.includes("outside"),
      "out-of-region telemetry is rejected instead of corrupting the spatial index",
    );
    assert(tree.size() === 1, "rejected telemetry leaves the prior indexed position intact");
  }

  console.log("\n[4] Request IDs cannot cross rider identities");
  {
    const stateMachine = new TripStateMachine();
    const first = stateMachine.createTrip({
      requestId: "shared_request_id",
      riderId: "rider_one",
      pickup: { lat: 37.775, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.41 },
    });
    const replay = stateMachine.createTrip({
      requestId: "shared_request_id",
      riderId: "rider_two",
      pickup: { lat: 37.775, lng: -122.42 },
      dropoff: { lat: 37.79, lng: -122.41 },
    });

    assert(first.success, "initial request ID is accepted");
    assert(!replay.success, "a request ID replay from another rider is rejected");
  }

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
