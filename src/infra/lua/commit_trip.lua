-- KEYS[1] = "driver:lock:" .. driverId
-- KEYS[2] = "driver:state:" .. driverId
-- ARGV[1] = expected requestId

-- 1. Check if the lock is still held by this requestId
if redis.call("get", KEYS[1]) == ARGV[1] then
    -- 2. Atomically delete the temporary lock
    redis.call("del", KEYS[1])

    -- 3. Atomically set the driver status to 'busy' in their Redis state hash
    redis.call("hset", KEYS[2], "status", "busy", "currentTripRequestId", ARGV[1])

    return 1 -- Commit successful
else
    return 0 -- Commit failed (lock expired or was stolen)
end
