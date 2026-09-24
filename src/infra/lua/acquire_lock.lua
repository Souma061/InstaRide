-- KEYS[1]: driver_lock:{driverId}
-- KEYS[2]: driver:state:{driverId}
-- ARGV[1]: requestId
-- ARGV[2]: ttlMs

-- 1. If another process committed this driver as busy, reject immediately
local currentStatus = redis.call("HGET", KEYS[2], "status")
if currentStatus == "busy" then
    return 0
end

-- 2. Acquire atomic lock with TTL
local acquired = redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])
if acquired then
    return 1
end

return 0
