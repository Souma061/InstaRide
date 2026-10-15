import cassandra from "cassandra-driver";

const { Client } = cassandra;

let clientInstance: cassandra.Client | null = null;

export interface CassandraConfig {
  contactPoints?: string[];
  localDataCenter?: string;
  keyspace?: string;
}

export function getCassandraClient(
  config: CassandraConfig = {},
): cassandra.Client {
  if (!clientInstance) {
    const contactPoints = config.contactPoints || [
      process.env.CASSANDRA_HOST || "127.0.0.1",
    ];
    const localDataCenter =
      config.localDataCenter ||
      process.env.CASSANDRA_DC ||
      "datacenter1";

    clientInstance = new Client({
      contactPoints,
      localDataCenter,
      keyspace: config.keyspace || "instaride",
      pooling: {
        coreConnectionsPerHost: {
          [cassandra.types.distance.local]: 2,
          [cassandra.types.distance.remote]: 1,
        },
      },
    });
  }
  return clientInstance;
}

/**
 * Initializes the Cassandra keyspace and tables for InstaRide.
 */
export async function initCassandraSchema(
  contactPoints: string[] = [process.env.CASSANDRA_HOST || "127.0.0.1"],
  localDataCenter: string = process.env.CASSANDRA_DC || "datacenter1",
): Promise<void> {
  const rootClient = new Client({
    contactPoints,
    localDataCenter,
  });

  try {
    await rootClient.connect();

    // 1. Create Keyspace
    await rootClient.execute(`
      CREATE KEYSPACE IF NOT EXISTS instaride
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
    `);

    // 2. Driver Breadcrumbs (Time-Series partitioned by driver + date)
    await rootClient.execute(`
      CREATE TABLE IF NOT EXISTS instaride.driver_breadcrumbs (
        driver_id text,
        date text,
        timestamp timestamp,
        lat double,
        lng double,
        speed double,
        heading double,
        status text,
        PRIMARY KEY ((driver_id, date), timestamp)
      ) WITH CLUSTERING ORDER BY (timestamp DESC);
    `);

    // 3. Trip Audit Log (Immutable append-only state transition journal)
    await rootClient.execute(`
      CREATE TABLE IF NOT EXISTS instaride.trip_audit_log (
        trip_id text,
        timestamp timestamp,
        from_status text,
        to_status text,
        triggered_by text,
        reason text,
        payload text,
        PRIMARY KEY ((trip_id), timestamp, to_status)
      ) WITH CLUSTERING ORDER BY (timestamp ASC, to_status ASC);
    `);

    // 4. Benchmark GPS Table
    await rootClient.execute(`
      CREATE TABLE IF NOT EXISTS instaride.gps_bench (
        driver_id text,
        ping_time timestamp,
        lat double,
        lng double,
        PRIMARY KEY ((driver_id), ping_time)
      ) WITH CLUSTERING ORDER BY (ping_time DESC);
    `);
  } finally {
    await rootClient.shutdown();
  }
}
