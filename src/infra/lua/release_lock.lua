-- KEYS[1] = "driver:lock:<driverId>"
-- ARGV[1] = expected requestId



if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
