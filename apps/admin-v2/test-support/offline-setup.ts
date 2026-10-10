import net from "node:net";

// Mocks still work; an accidental real HTTP request fails before DNS or TCP.
net.Socket.prototype.connect = function () {
  throw new Error("Outbound sockets are disabled in the offline admin UI suite");
};
