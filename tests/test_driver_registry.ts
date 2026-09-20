import { DriverRegistry } from '../src/core/driver_registry.js';
import { QuadTree } from '../src/spatial/quadtree.js';

const SF_BOUNDS = {
  minLat: 37.7081,
  maxLat: 37.8324,
  minLng: -122.527,
  maxLng: -122.3482,
};

console.log('=====================================================');
console.log('       DRIVER REGISTRY: TEST & VERIFICATION          ');
console.log('=====================================================\n');

const tree = new QuadTree(SF_BOUNDS, 8, 7);
const registry = new DriverRegistry(tree);

// 1. Registration & Availability
console.log('[1] Testing Driver Registration & Initial State...');
const d1 = registry.registerDriver('d1', 37.75, -122.45, 'available');
const d2 = registry.registerDriver('d2', 37.76, -122.44, 'offline');

console.log('    Driver d1 registered:', d1.status);
console.log('    Driver d2 registered:', d2.status);
console.log('    QuadTree size (should be 1, only available):', tree.size());
if (tree.size() !== 1) throw new Error('Invariant failed: Only available drivers must be in QuadTree');

// 2. Telemetry Updates
console.log('\n[2] Testing Telemetry Updates & Out-of-bounds Rejection...');
const updateOk = registry.updateLocation('d1', 37.751, -122.451);
const badUpdate = registry.updateLocation('d1', 1999, -122.451); // invalid lat
console.log('    Valid update result:', updateOk);
console.log('    Corrupt update result (should be false):', badUpdate);
if (!updateOk || badUpdate) throw new Error('Coordinate validation failed');

// 3. Atomic Lock Acquisition & Concurrency Protection
console.log('\n[3] Testing Atomic Lock Acquisition...');
const lock1 = registry.acquireLock('d1', 'req_100', 15_000);
console.log('    Request 100 acquired lock on d1:', lock1);
console.log('    QuadTree size after lock (should be 0):', tree.size());
if (!lock1 || tree.size() !== 0) throw new Error('Lock acquisition failed to pull driver from QuadTree');

// Competing request tries to acquire the same driver
const lockCompete = registry.acquireLock('d1', 'req_200', 15_000);
console.log('    Competing Request 200 lock attempt (should be false):', lockCompete);
if (lockCompete) throw new Error('Race condition failure: Double lock allowed!');

// Competing k-NN query should find 0 available drivers
const candidates = registry.findNearbyCandidates(37.75, -122.45, 4);
console.log('    Nearby candidates visible during lock (should be 0):', candidates.length);
if (candidates.length !== 0) throw new Error('Locked driver was visible to spatial query');

// 4. Safe Lock Release
console.log('\n[4] Testing Safe Lock Release (Wrong vs Right RequestId)...');
const wrongRelease = registry.releaseLock('d1', 'wrong_req');
console.log('    Release with wrong requestId (should be false):', wrongRelease);
const correctRelease = registry.releaseLock('d1', 'req_100');
console.log('    Release with matching requestId:', correctRelease);
console.log('    QuadTree size after release (should be 1):', tree.size());
if (wrongRelease || !correctRelease || tree.size() !== 1) throw new Error('Safe release failed');

// 5. Trip Commitment & Completion Lifecycle
console.log('\n[5] Testing Trip Commit & Lifecycle Transitions...');
registry.acquireLock('d1', 'req_300', 15_000);
const commitOk = registry.commitTrip('d1', 'req_300');
console.log('    Trip commit result:', commitOk);
console.log('    Driver status after commit (should be busy):', registry.getDriver('d1')?.status);
console.log('    QuadTree size during active trip (should be 0):', tree.size());
if (!commitOk || registry.getDriver('d1')?.status !== 'busy' || tree.size() !== 0) {
  throw new Error('Trip commit failed');
}

// Complete trip -> returns to available
registry.completeTrip('d1');
console.log('    Driver status after trip completion (should be available):', registry.getDriver('d1')?.status);
console.log('    QuadTree size after trip completion (should be 1):', tree.size());
if (registry.getDriver('d1')?.status !== 'available' || tree.size() !== 1) {
  throw new Error('Complete trip failed');
}

// 6. Expired Lock Auto-Cleanup
console.log('\n[6] Testing Expired Lock Auto-Cleanup...');
registry.acquireLock('d1', 'req_400', 50); // 50ms lock TTL
await new Promise(r => setTimeout(r, 70)); // Wait for expiration

// New request should succeed because previous lock expired
const lockAfterExpire = registry.acquireLock('d1', 'req_500', 15_000);
console.log('    Lock acquisition after previous expired (should be true):', lockAfterExpire);
if (!lockAfterExpire) throw new Error('Expired lock did not clean up');
registry.releaseLock('d1', 'req_500');

// 7. Stale Driver Disconnect Eviction
console.log('\n[7] Testing Stale Driver Eviction...');
// Artificially age driver d1's lastSeen
const d1Record = registry.getDriver('d1')!;
d1Record.lastSeen = Date.now() - 40_000; // 40 seconds ago (>30s timeout)

const evicted = registry.evictStaleDrivers(30_000);
console.log('    Evicted stale drivers:', evicted);
console.log('    Driver d1 status after eviction:', d1Record.status);
console.log('    QuadTree size after eviction (should be 0):', tree.size());
if (!evicted.includes('d1') || d1Record.status !== 'offline' || tree.size() !== 0) {
  throw new Error('Stale eviction failed');
}

console.log('\n=====================================================');
console.log('      ALL DRIVER REGISTRY TESTS PASSED (100%)        ');
console.log('=====================================================');
