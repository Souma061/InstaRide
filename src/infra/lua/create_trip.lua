-- KEYS[1]: request:trip:{requestId}
-- KEYS[2]: rider:active_trip:{riderId}
-- KEYS[3]: trip:{tripId}
-- KEYS[4]: trip:active
-- ARGV[1]: tripId
-- ARGV[2]: tripJson
-- ARGV[3]: riderTtlSeconds (e.g. 7200)

-- 1. Idempotency Check: if request already exists, return its tripId
local existingTripId = redis.call("GET", KEYS[1])
if existingTripId then
    return { 1, existingTripId }
end

-- 2. Guard: Rider cannot have more than 1 active trip
local riderClaimed = redis.call("SET", KEYS[2], ARGV[1], "NX", "EX", ARGV[3])
if not riderClaimed then
    return { 0, "RIDER_ALREADY_HAS_ACTIVE_TRIP" }
end

-- 3. Register trip data atomically
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[3], ARGV[2])
redis.call("SADD", KEYS[4], ARGV[1])

return { 2, ARGV[1] }
