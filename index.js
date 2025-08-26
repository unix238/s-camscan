import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.get("/", (_, res) => res.send("Signaling server is running"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 15000);

let sender = null;
const receivers = new Set();

// --- Socket.IO signaling ---
io.on("connection", (socket) => {
  console.log(`+ connected ${socket.id}`);

  // Register sender or receiver
  socket.on("register", ({ role } = {}) => {
    role = role === "receiver" ? "receiver" : "sender";
    socket.data.role = role;

    if (role === "sender") {
      // evict old sender if exists
      if (sender && sender !== socket.id) {
        io.to(sender).emit("sender-replaced");
      }
      sender = socket.id;
      console.log(`sender = ${socket.id}`);

      // notify sender if receivers are waiting
      if (receivers.size > 0) {
        io.to(sender).emit("receiver-ready", { count: receivers.size });
      }
    } else {
      receivers.add(socket.id);
      console.log(`receiver joined ${socket.id}`);
      if (sender) {
        io.to(sender).emit("receiver-ready", {
          receiverId: socket.id,
          count: receivers.size,
        });
      }
    }
  });

  // Sender → Receivers: offer
  socket.on("offer", (offer) => {
    if (socket.id !== sender) return;
    socket.broadcast.emit("offer", offer);
  });

  // Receiver → Sender: answer
  socket.on("answer", (answer) => {
    if (sender) {
      io.to(sender).emit("answer", answer);
    }
  });

  // ICE candidates both ways
  socket.on("ice-candidate", (candidate) => {
    if (socket.data.role === "sender") {
      socket.broadcast.emit("ice-candidate", candidate);
    } else if (sender) {
      io.to(sender).emit("ice-candidate", candidate);
    }
  });

  // Optional: stop stream
  socket.on("stop", () => {
    if (socket.data.role === "sender") {
      socket.broadcast.emit("stream-stopped");
    }
  });

  // keep-alive ping
  const pingTimer = setInterval(() => {
    socket.emit("ping", { t: Date.now() });
  }, PING_INTERVAL_MS);

  socket.on("pong", () => {});

  // cleanup on disconnect
  socket.on("disconnect", () => {
    clearInterval(pingTimer);

    if (socket.id === sender) {
      sender = null;
      socket.broadcast.emit("receiver-disconnected");
      console.log(`- sender disconnected ${socket.id}`);
    } else if (receivers.has(socket.id)) {
      receivers.delete(socket.id);
      if (sender) {
        io.to(sender).emit("receiver-count", { count: receivers.size });
      }
      console.log(`- receiver disconnected ${socket.id}`);
    } else {
      console.log(`- disconnected ${socket.id}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
});
