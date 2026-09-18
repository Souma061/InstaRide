import websocket from "@fastify/websocket";
import Fastify from "fastify";

const fastify = Fastify({
  logger: true,
});

// Register WebSocket plugin
await fastify.register(websocket);

// Basic HTTP health check
fastify.get("/health", async () => {
  return {
    status: "ok",
    service: "ride-matching-backend",
    timestamp: new Date().toISOString(),
  };
});

// Basic WebSocket handshake & ping-pong verification
fastify.get("/ws", { websocket: true }, (socket, req) => {
  fastify.log.info("Client connected to WebSocket");

  socket.on("message", (message: Buffer | string) => {
    try {
      const parsed = JSON.parse(message.toString());
      fastify.log.info({ received: parsed }, "WS message received");

      if (parsed.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      } else {
        socket.send(JSON.stringify({ type: "ack", payload: parsed }));
      }
    } catch {
      socket.send(
        JSON.stringify({ type: "error", message: "Invalid JSON frame" }),
      );
    }
  });

  socket.on("close", () => {
    fastify.log.info("Client disconnected from WebSocket");
  });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

try {
  await fastify.listen({ port: PORT, host: HOST });
  console.log(`Server is running at http://localhost:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
